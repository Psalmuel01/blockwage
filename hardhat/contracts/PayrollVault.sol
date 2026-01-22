// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PayrollVault - Simplified for Cronos x402 Facilitator
 * @dev Manages payroll deposits and payment tracking for BlockWage
 *
 * Key Changes from Original:
 * - Removed PaymentVerifier dependency (facilitator handles verification)
 * - Removed releaseSalary() (facilitator executes direct USDC transfer via EIP-3009)
 * - Added recordPayment() to track payments settled by facilitator
 * - Simplified to focus on fund custody and payment tracking
 *
 * Flow:
 * 1. Employer deposits USDC for specific periods
 * 2. Employee claims salary via backend (returns 402 response)
 * 3. Employee signs EIP-3009 authorization
 * 4. Cronos Facilitator executes gasless USDC transfer
 * 5. Facilitator webhook calls backend
 * 6. Backend calls recordPayment() to mark as paid and update accounting
 */

interface ISalarySchedule {
    function isDue(
        address employee,
        uint256 periodId
    ) external view returns (bool, string memory);

    function confirmPaid(
        address employee,
        uint256 periodId,
        uint256 paidTimestamp
    ) external;
}

contract PayrollVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Stablecoin token (USDC with EIP-3009 support)
    IERC20 public immutable token;

    // Linked SalarySchedule contract
    ISalarySchedule public salarySchedule;

    // Period deposits: periodId => total deposited
    mapping(uint256 => uint256) public periodBalances;

    // Payment tracking: employee => periodId => paid
    mapping(address => mapping(uint256 => bool)) public paid;

    // Total balance held (for accounting)
    uint256 public totalBalance;

    // Events
    event PayrollDeposited(
        address indexed from,
        uint256 indexed periodId,
        uint256 amount
    );

    event PaymentRecorded(
        address indexed employee,
        uint256 indexed periodId,
        uint256 amount,
        uint256 timestamp
    );

    event SalaryScheduleUpdated(address indexed schedule);

    event FundsWithdrawn(address indexed to, uint256 amount);

    /**
     * @param _token USDC token address (must support EIP-3009)
     * @param _salarySchedule SalarySchedule contract address
     */
    constructor(address _token, address _salarySchedule) Ownable(msg.sender) {
        require(_token != address(0), "token-zero");
        require(_salarySchedule != address(0), "schedule-zero");

        token = IERC20(_token);
        salarySchedule = ISalarySchedule(_salarySchedule);

        emit SalaryScheduleUpdated(_salarySchedule);
    }

    /* ===========================
       Administration
       =========================== */

    /**
     * @notice Update the SalarySchedule contract address
     * @param _schedule New schedule address
     */
    function setSalarySchedule(address _schedule) external onlyOwner {
        require(_schedule != address(0), "schedule-zero");
        salarySchedule = ISalarySchedule(_schedule);
        emit SalaryScheduleUpdated(_schedule);
    }

    /* ===========================
       Deposit & Withdrawal
       =========================== */

    /**
     * @notice Deposit funds for a payroll period
     * @dev Employer must approve token transfer before calling
     * @param periodId Period identifier (unix timestamp aligned to cadence)
     * @param amount Amount of USDC to deposit (in smallest units)
     */
    function depositPayroll(
        uint256 periodId,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(amount > 0, "amount-zero");

        // Transfer USDC from employer to vault
        token.safeTransferFrom(msg.sender, address(this), amount);

        // Update period balance and total
        periodBalances[periodId] += amount;
        totalBalance += amount;

        emit PayrollDeposited(msg.sender, periodId, amount);
    }

    /**
     * @notice Withdraw excess funds (not allocated to any period)
     * @dev Only callable by owner for emergency recovery
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function withdrawExcess(
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(to != address(0), "to-zero");
        require(amount <= totalBalance, "insufficient-balance");

        totalBalance -= amount;
        token.safeTransfer(to, amount);

        emit FundsWithdrawn(to, amount);
    }

    /* ===========================
       Payment Recording (Post-Facilitator)
       =========================== */

    /**
     * @notice Record a payment that was settled by Cronos Facilitator
     * @dev Called by backend after receiving facilitator webhook
     *
     * The actual USDC transfer happens via EIP-3009 (transferWithAuthorization),
     * executed by the facilitator. This function just records the payment occurred
     * and updates our accounting.
     *
     * @param employee Employee address
     * @param periodId Period identifier
     * @param amount Amount that was paid
     */
    function recordPayment(
        address employee,
        uint256 periodId,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(employee != address(0), "employee-zero");
        require(!paid[employee][periodId], "already-paid");

        // Verify payment is actually due according to schedule
        (bool due, string memory reason) = salarySchedule.isDue(
            employee,
            periodId
        );
        require(due, reason);

        // Ensure we had allocated funds for this period
        require(
            periodBalances[periodId] >= amount,
            "insufficient-period-funds"
        );

        // Mark as paid (prevents double-payment)
        paid[employee][periodId] = true;

        // Deduct from period balance
        periodBalances[periodId] -= amount;

        // Note: totalBalance is NOT decreased here because the USDC was already
        // transferred directly from employee's signature via EIP-3009.
        // The vault never actually held these specific funds for the transfer.

        emit PaymentRecorded(employee, periodId, amount, block.timestamp);

        // Confirm payment on schedule contract
        try salarySchedule.confirmPaid(employee, periodId, block.timestamp) {
            // Success
        } catch {
            // Swallow error; owner can manually sync if needed
        }
    }

    /* ===========================
       View Functions
       =========================== */

    /**
     * @notice Check if a payment has been recorded
     * @param employee Employee address
     * @param periodId Period identifier
     * @return True if payment was recorded
     */
    function isPaid(
        address employee,
        uint256 periodId
    ) external view returns (bool) {
        return paid[employee][periodId];
    }

    /**
     * @notice Get available balance for a specific period
     * @param periodId Period identifier
     * @return Available balance for that period
     */
    function getPeriodBalance(
        uint256 periodId
    ) external view returns (uint256) {
        return periodBalances[periodId];
    }

    /**
     * @notice Get vault's total USDC balance
     * @return Current USDC balance of the vault
     */
    function getVaultBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /* ===========================
       Emergency Functions
       =========================== */

    /**
     * @notice Admin can clear paid flag for recovery
     * @dev Use with extreme caution - only for error correction
     */
    function adminClearPaid(
        address employee,
        uint256 periodId
    ) external onlyOwner {
        paid[employee][periodId] = false;
    }

    /**
     * @notice Emergency token rescue
     * @dev Allows recovery of accidentally sent tokens
     */
    function rescueTokens(
        address tokenAddress,
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(to != address(0), "to-zero");
        IERC20(tokenAddress).safeTransfer(to, amount);
    }
}
