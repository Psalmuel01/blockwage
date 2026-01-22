// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title SalarySchedule
 * @dev Salary scheduling and validation contract for BlockWage (Cronos / x402 payroll)
 *
 * Responsibilities:
 *  - Maintain employee salary/cadence metadata
 *  - Validate pay periods for different cadences (Monthly / Biweekly / Hourly / Minute)
 *  - Emit `SalaryDue` events when payroll is due (scheduler or owner triggers)
 *  - Integrate with a PayrollVault via a callback (`onSalaryDue`) so on-chain settlement can be coordinated
 *
 * Notes:
 *  - Period identifiers are represented as unix timestamps that MUST be aligned to the cadence window:
 *      * Minute   -> seconds since epoch aligned to minute boundary (periodId % 60 == 0)
 *      * Hourly   -> seconds since epoch aligned to hour boundary (periodId % 3600 == 0)
 *      * Biweekly -> seconds since epoch aligned to 14-day boundary   (periodId % (14*24*3600) == 0)
 *      * Monthly  -> seconds since epoch aligned to 30-day boundary   (periodId % (30*24*3600) == 0)
 *
 *  This design keeps period arithmetic simple and deterministic between off-chain scheduler and on-chain validation.
 *
 * Security:
 *  - Access control via Ownable
 *  - ReentrancyGuard applied on functions that call external vaults
 *  - Tracks processed periods to prevent double-issuance (periodProcessed)
 *
 * Integration:
 *  - PayrollVault must implement `onSalaryDue(address,uint256,uint256)`; owner sets the vault address.
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPayrollVault {
    /// Called by this schedule contract when a salary becomes due.
    /// Vault should ensure funds exist and proceed with on-chain settlement or bookkeeping.
    function onSalaryDue(
        address employee,
        uint256 amount,
        uint256 periodId
    ) external;
}

contract SalarySchedule is Ownable, ReentrancyGuard {
    enum Cadence {
        Minute, // for testing
        Hourly,
        Biweekly,
        Monthly
    }

    struct Employee {
        uint256 salary; // salary amount in token smallest unit (e.g., USDC with 6 decimals)
        Cadence cadence;
        uint256 lastPaidTimestamp; // unix timestamp of last successful payment (or 0 if none)
        bool exists;
    }

    // cadence durations in seconds (used for validation)
    uint256 public constant MINUTE = 60;
    uint256 public constant HOUR = 3600;
    uint256 public constant DAY = 24 * 3600;
    uint256 public constant BIWEEK = 14 * DAY;
    uint256 public constant THIRTY_DAY = 30 * DAY;

    // token used for payouts (e.g., devUSDC on Cronos testnet). Read-only for schedule; actual transfers handled by Vault.
    address public immutable token;

    // payroll vault address to callback when a salary is due
    address public payrollVault;

    // employee data
    mapping(address => Employee) public employees;

    // guard against duplicate processing per (employee, periodId)
    mapping(address => mapping(uint256 => bool)) public periodProcessed;

    // Events
    event EmployeeAssigned(
        address indexed employee,
        uint256 salary,
        Cadence cadence
    );
    event EmployeeUpdated(
        address indexed employee,
        uint256 oldSalary,
        uint256 newSalary,
        Cadence oldCadence,
        Cadence newCadence
    );
    event EmployeeRemoved(address indexed employee);
    event PayrollVaultUpdated(address indexed newVault);
    event SalaryDue(
        address indexed employee,
        uint256 amount,
        address token,
        uint256 periodId
    );
    event PeriodProcessed(address indexed employee, uint256 periodId);

    /**
     * @param _token Stablecoin token used for reporting (not transferred here). For example devUSDC.e on Cronos testnet.
     */
    constructor(address _token) Ownable(msg.sender) {
        require(_token != address(0), "token-zero");
        token = _token;
    }

    /* ============================
       Employer / Owner functions
       ============================ */

    /**
     * @notice Assign an employee to the schedule (or update)
     * @param _employee employee wallet address
     * @param _salary amount per cadence period (in token smallest unit)
     * @param _cadence pay cadence
     * @param _initialLastPaid optional initial last paid timestamp (useful when migrating)
     */
    function assignEmployee(
        address _employee,
        uint256 _salary,
        Cadence _cadence,
        uint256 _initialLastPaid
    ) external onlyOwner {
        require(_employee != address(0), "employee-zero");
        require(_salary > 0, "salary-zero");

        if (!employees[_employee].exists) {
            employees[_employee] = Employee({
                salary: _salary,
                cadence: _cadence,
                lastPaidTimestamp: _initialLastPaid,
                exists: true
            });
            emit EmployeeAssigned(_employee, _salary, _cadence);
        } else {
            Employee storage e = employees[_employee];
            uint256 oldSalary = e.salary;
            Cadence oldCadence = e.cadence;
            e.salary = _salary;
            e.cadence = _cadence;
            // optionally allow updating lastPaidTimestamp through a dedicated admin function to avoid accidental change
            emit EmployeeUpdated(
                _employee,
                oldSalary,
                _salary,
                oldCadence,
                _cadence
            );
        }
    }

    /**
     * @notice Remove an employee from the schedule
     */
    function removeEmployee(address _employee) external onlyOwner {
        require(employees[_employee].exists, "not-assigned");
        delete employees[_employee];
        emit EmployeeRemoved(_employee);
    }

    /**
     * @notice Set or update the PayrollVault address
     */
    function setPayrollVault(address _vault) external onlyOwner {
        require(_vault != address(0), "vault-zero");
        payrollVault = _vault;
        emit PayrollVaultUpdated(_vault);
    }

    /**
     * @notice Update last paid timestamp for an employee. Only for admin / migration.
     */
    function setLastPaidTimestamp(
        address _employee,
        uint256 _ts
    ) external onlyOwner {
        require(employees[_employee].exists, "not-assigned");
        employees[_employee].lastPaidTimestamp = _ts;
    }

    /* ============================
       Read / Validation helpers
       ============================ */

    /**
     * @notice Calculate cadence duration in seconds
     */
    function cadenceDuration(Cadence c) public pure returns (uint256) {
        if (c == Cadence.Minute) return MINUTE;
        if (c == Cadence.Hourly) return HOUR;
        if (c == Cadence.Biweekly) return BIWEEK;
        // Monthly approximated as 30 days for deterministic arithmetic
        return THIRTY_DAY;
    }

    /**
     * @notice Validate that provided periodId is aligned to cadence windows
     *
     * periodId MUST be unix timestamp aligned to cadence duration since epoch.
     * Examples:
     *  - Minute   : periodId % 60 == 0
     *  - Hourly   : periodId % 3600 == 0
     *  - Biweekly : periodId % (14*24*3600) == 0
     *  - Monthly  : periodId % (30*24*3600) == 0
     */
    function isPeriodAligned(
        Cadence c,
        uint256 periodId
    ) public pure returns (bool) {
        uint256 d = cadenceDuration(c);
        return (periodId % d) == 0;
    }

    /**
     * @notice Check if a salary is due for an employee at a given periodId
     * @dev This checks:
     *  - employee exists
     *  - periodId is aligned to cadence
     *  - periodId is strictly greater than employee.lastPaidTimestamp (prevents double pay on same or past periods)
     *  - period has not been processed before
     */
    function isDue(
        address _employee,
        uint256 periodId
    ) public view returns (bool, string memory) {
        Employee memory e = employees[_employee];
        if (!e.exists) return (false, "not-assigned");
        if (!isPeriodAligned(e.cadence, periodId))
            return (false, "period-misaligned");
        if (periodProcessed[_employee][periodId])
            return (false, "already-processed");
        if (periodId <= e.lastPaidTimestamp)
            return (false, "period-not-later-than-last-paid");
        // optionally ensure periodId is not in the far future (> now + slack)
        // allow a small slack window (e.g., scheduler may trigger slightly after period boundary)
        return (true, "");
    }

    /* ============================
       Trigger / Scheduler actions
       ============================ */

    /**
     * @notice Trigger salary due for a specific employee and period.
     * @dev Callable by owner (employer) or an off-chain scheduler that holds owner key.
     *
     * Steps:
     *  1. Validate period and double-pay protections
     *  2. Mark period processed to prevent double processing
     *  3. Emit SalaryDue event (x402-offchain components watch for this)
     *  4. Call payrollVault.onSalaryDue to allow vault to perform on-chain settlement/bookkeeping
     */
    function triggerSalaryDue(
        address _employee,
        uint256 periodId
    ) external nonReentrant onlyOwner {
        (bool ok, string memory reason) = isDue(_employee, periodId);
        require(ok, reason);

        Employee storage e = employees[_employee];

        // mark processed first (prevent reentrancy & double attempts)
        periodProcessed[_employee][periodId] = true;
        emit PeriodProcessed(_employee, periodId);

        // Emit SalaryDue to inform off-chain systems (scheduler / employee HTTP endpoint)
        emit SalaryDue(_employee, e.salary, token, periodId);

        // Callback to vault so it can lock funds / prepare settlement / emit settlement events
        if (payrollVault != address(0)) {
            // calling external contract - guard with nonReentrant and mark processed earlier
            IPayrollVault(payrollVault).onSalaryDue(
                _employee,
                e.salary,
                periodId
            );
        }
    }

    /**
     * @notice Mark a period as paid. This must be called by the owner (or vault via admin) after on-chain settlement completes.
     * @dev Recording lastPaidTimestamp prevents the same or older periods from being re-issued.
     */
    function confirmPaid(
        address _employee,
        uint256 periodId,
        uint256 paidTimestamp
    ) external onlyOwner {
        require(employees[_employee].exists, "not-assigned");
        require(periodProcessed[_employee][periodId], "period-not-processed");
        // only allow monotonic progression
        require(
            paidTimestamp > employees[_employee].lastPaidTimestamp,
            "ts-not-later"
        );
        employees[_employee].lastPaidTimestamp = paidTimestamp;
    }

    /* ============================
       View helpers
       ============================ */

    function getEmployee(
        address _employee
    )
        external
        view
        returns (
            uint256 salary,
            Cadence cadence,
            uint256 lastPaid,
            bool exists_
        )
    {
        Employee memory e = employees[_employee];
        return (e.salary, e.cadence, e.lastPaidTimestamp, e.exists);
    }

    /**
     * @notice Helper to compute next expected period start for an employee based on lastPaidTimestamp
     */
    function nextExpectedPeriod(
        address _employee
    ) external view returns (uint256) {
        Employee memory e = employees[_employee];
        require(e.exists, "not-assigned");
        uint256 d = cadenceDuration(e.cadence);
        if (e.lastPaidTimestamp == 0) {
            // if never paid, return the next aligned period >= now (we align now down to cadence)
            uint256 alignedNow = (block.timestamp / d) * d;
            return alignedNow;
        } else {
            uint256 candidate = e.lastPaidTimestamp + d;
            // align candidate to cadence window (should be aligned already)
            uint256 aligned = (candidate / d) * d;
            return aligned;
        }
    }

    /* ============================
       Emergency / admin helpers
       ============================ */

    /**
     * @notice Admin may clear the processed flag for a period if a manual correction is required.
     * Use with caution - only for recovery/ops.
     */
    function adminClearProcessed(
        address _employee,
        uint256 periodId
    ) external onlyOwner {
        periodProcessed[_employee][periodId] = false;
    }

    /**
     * @notice Admin can force emit a SalaryDue without marking processed or calling vault.
     * This is provided for ops/debugging and should NOT be used in normal flows.
     */
    function adminEmitSalaryDue(
        address _employee,
        uint256 periodId
    ) external onlyOwner {
        require(employees[_employee].exists, "not-assigned");
        Employee memory e = employees[_employee];
        emit SalaryDue(_employee, e.salary, token, periodId);
    }
}
