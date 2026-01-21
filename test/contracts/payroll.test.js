/**
 * Vibe Coding/blockwage/test/contracts/payroll.test.js
 *
 * Hardhat / Mocha tests for:
 *  - SalarySchedule.sol
 *  - PayrollVault.sol
 *  - PaymentVerifier.sol
 *
 * NOTE:
 *  - These tests assume the contracts in `contracts/` were compiled by Hardhat.
 *  - The tests use OpenZeppelin's `ERC20PresetMinterPauser` token from node modules for a test stablecoin (devUSDC-like).
 *  - Ensure your Hardhat environment has access to OpenZeppelin contracts (installed via npm) or provide a TestToken
 *    in `contracts/` compatible with the usage below (mintable token).
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BlockWage Payroll Contracts (unit tests)", function () {
  let deployer, employer, employee, other;
  let TestToken, token;
  let SalarySchedule, salarySchedule;
  let PaymentVerifier, paymentVerifier;
  let PayrollVault, payrollVault;

  // token decimals to use in parseUnits (USDC has 6 decimals)
  const DECIMALS = 6;

  beforeEach(async function () {
    [deployer, employer, employee, other] = await ethers.getSigners();

    // Deploy a mintable ERC20 token for tests.
    // Using OpenZeppelin preset from node_modules via fully qualified name.
    const TokenFactory = await ethers.getContractFactory(
      "@openzeppelin/contracts/token/ERC20/presets/ERC20PresetMinterPauser.sol:ERC20PresetMinterPauser"
    );
    token = await TokenFactory.deploy("Dev USDC", "dUSDC");
    await token.deployed();

    // Mint some tokens to deployer (owner/employer)
    const mintAmount = ethers.utils.parseUnits("1000", DECIMALS); // 1000 USDC
    await token.mint(deployer.address, mintAmount);

    // Deploy PaymentVerifier
    PaymentVerifier = await ethers.getContractFactory("PaymentVerifier");
    paymentVerifier = await PaymentVerifier.connect(deployer).deploy();
    await paymentVerifier.deployed();

    // Deploy SalarySchedule (requires token address in constructor)
    SalarySchedule = await ethers.getContractFactory("SalarySchedule");
    salarySchedule = await SalarySchedule.connect(deployer).deploy(token.address);
    await salarySchedule.deployed();

    // Deploy PayrollVault; its constructor signature in our contract requires (token, salarySchedule, paymentVerifier)
    PayrollVault = await ethers.getContractFactory("PayrollVault");
    payrollVault = await PayrollVault.connect(deployer).deploy(
      token.address,
      salarySchedule.address,
      paymentVerifier.address
    );
    await payrollVault.deployed();

    // Wire schedule -> vault if needed (schedule stores payrollVault, used by some flows)
    await salarySchedule.connect(deployer).setPayrollVault(payrollVault.address);

    // For convenience, make deployer the owner/administrator in all contracts (it's the default deployer).
    // Assign an employee in both the schedule and vault mirror.
    // Cadence enum values: 0 = Hourly, 1 = Biweekly, 2 = Monthly
    const salaryAmount = ethers.utils.parseUnits("1", DECIMALS); // 1 USDC per period
    await salarySchedule.connect(deployer).assignEmployee(employee.address, salaryAmount, 2, 0);
    // Vault also keeps a mirror for amounts; use same cadence (2 = Monthly)
    await payrollVault.connect(deployer).assignEmployee(employee.address, salaryAmount, 2, 0);
  });

  it("happy path: deposit, verify proof, release salary to employee", async function () {
    // compute a monthly-aligned periodId (SalarySchedule uses 30-day months approximation)
    const THIRTY_DAY = 30 * 24 * 3600;
    const now = Math.floor(Date.now() / 1000);
    const periodId = Math.floor(now / THIRTY_DAY) * THIRTY_DAY;

    // deposit funds for the period into the vault (owner/deployer must approve then deposit)
    const depositAmount = ethers.utils.parseUnits("1", DECIMALS); // 1 USDC
    // Approve vault to pull tokens
    await token.connect(deployer).approve(payrollVault.address, depositAmount);
    // depositPayroll is owner-only in our vault; deployer is owner
    await payrollVault.connect(deployer).depositPayroll(periodId, depositAmount);

    // Build facilitator proof (abi-encoded address,uint256,uint256) - matches PaymentVerifier parsing expectations
    // Use ethers default abi encoder so that each value is 32-byte aligned (address -> 12 bytes padding + 20 bytes address)
    const proof = ethers.utils.defaultAbiCoder.encode(
      ["address", "uint256", "uint256"],
      [employee.address, periodId, depositAmount]
    );

    // Call paymentVerifier.verifyPayment to register/verify the proof (simulates facilitator acceptance)
    const txVerify = await paymentVerifier.connect(deployer).verifyPayment(proof);
    await txVerify.wait();

    // Release salary via PayrollVault (onlyOwner). Deployer is owner and calls releaseSalary.
    const txRelease = await payrollVault.connect(deployer).releaseSalary(employee.address, periodId);
    await txRelease.wait();

    // Employee should have received the tokens
    const empBal = await token.balanceOf(employee.address);
    expect(empBal).to.equal(depositAmount);

    // Vault should mark paid
    const isPaid = await payrollVault.isPaid(employee.address, periodId);
    expect(isPaid).to.equal(true);
  });

  it("prevents double payout: cannot release same employee+period twice", async function () {
    const THIRTY_DAY = 30 * 24 * 3600;
    const now = Math.floor(Date.now() / 1000);
    const periodId = Math.floor(now / THIRTY_DAY) * THIRTY_DAY;

    // deposit and approve
    const depositAmount = ethers.utils.parseUnits("1", DECIMALS);
    await token.connect(deployer).approve(payrollVault.address, depositAmount);
    await payrollVault.connect(deployer).depositPayroll(periodId, depositAmount);

    const proof = ethers.utils.defaultAbiCoder.encode(
      ["address", "uint256", "uint256"],
      [employee.address, periodId, depositAmount]
    );
    await paymentVerifier.connect(deployer).verifyPayment(proof);

    // First release should succeed
    await payrollVault.connect(deployer).releaseSalary(employee.address, periodId);

    // Second release should revert (already-paid)
    await expect(
      payrollVault.connect(deployer).releaseSalary(employee.address, periodId)
    ).to.be.revertedWith("already-paid");
  });

  it("fails release if insufficient funds in period balance", async function () {
    const THIRTY_DAY = 30 * 24 * 3600;
    const now = Math.floor(Date.now() / 1000);
    const periodId = Math.floor(now / THIRTY_DAY) * THIRTY_DAY;

    // Do NOT deposit for this period on purpose.

    // Build and register proof
    const amount = ethers.utils.parseUnits("1", DECIMALS);
    const proof = ethers.utils.defaultAbiCoder.encode(
      ["address", "uint256", "uint256"],
      [employee.address, periodId, amount]
    );
    await paymentVerifier.connect(deployer).verifyPayment(proof);

    // Attempt to release should fail due to insufficient-period-funds
    await expect(
      payrollVault.connect(deployer).releaseSalary(employee.address, periodId)
    ).to.be.revertedWith("insufficient-period-funds");
  });

  it("salary schedule rejects misaligned period", async function () {
    // Create a misaligned periodId for Monthly cadence: pick now + 1 day so it's not aligned to 30-day boundary
    const misalignedPeriod = Math.floor(Date.now() / 1000) + (24 * 3600);

    // Call isDue on schedule: expected to return (false, 'period-misaligned')
    const result = await salarySchedule.isDue(employee.address, misalignedPeriod);
    // result is [bool, string]
    expect(result[0]).to.equal(false);
    expect(result[1]).to.contain("period-misaligned");
  });

  it("admin can emit SalaryDue event without vault callback (adminEmitSalaryDue) and vault retains funds", async function () {
    // This test demonstrates adminEmitSalaryDue event path (off-chain scheduler can listen) and vault accounting
    const THIRTY_DAY = 30 * 24 * 3600;
    const now = Math.floor(Date.now() / 1000);
    const periodId = Math.floor(now / THIRTY_DAY) * THIRTY_DAY;

    // deposit to vault for the period
    const depositAmount = ethers.utils.parseUnits("1", DECIMALS);
    await token.connect(deployer).approve(payrollVault.address, depositAmount);
    await payrollVault.connect(deployer).depositPayroll(periodId, depositAmount);

    // listen for SalaryDue event
    const filter = salarySchedule.filters.SalaryDue(employee.address);
    const promiseEvent = new Promise((resolve) => {
      salarySchedule.once(filter, (emp, amount, tok, pid) => {
        resolve({ emp, amount, tok, pid });
      });
    });

    // Emit SalaryDue via adminEmitSalaryDue (does not mark processed or call vault)
    await salarySchedule.connect(deployer).adminEmitSalaryDue(employee.address, periodId);

    const ev = await promiseEvent;
    expect(ev.emp).to.equal(employee.address);
    // amount is uint in event - compare rough value (1 USDC)
    expect(ev.amount.toString()).to.equal(ethers.utils.parseUnits("1", DECIMALS).toString());

    // Vault still has period balance available
    // There is no direct getter to enumerate periodBalances in a friendly way in some implementations.
    // But `releaseSalary` will succeed once proof is registered (this also exercises the release flow).
    const proof = ethers.utils.defaultAbiCoder.encode(
      ["address", "uint256", "uint256"],
      [employee.address, periodId, depositAmount]
    );
    await paymentVerifier.connect(deployer).verifyPayment(proof);

    // release (owner)
    await payrollVault.connect(deployer).releaseSalary(employee.address, periodId);

    const empBal = await token.balanceOf(employee.address);
    expect(empBal).to.equal(depositAmount);
  });
});
