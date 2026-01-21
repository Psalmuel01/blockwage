/**
 * deploy.ts
 *
 * Hardhat deployment script for BlockWage (Cronos / x402 Automated Payroll)
 *
 * Usage:
 *   - Configure .env in project root with:
 *       DEPLOYER_PRIVATE_KEY=0x...
 *       RPC_URL=<cronos testnet RPC>
 *       STABLE_TOKEN=<optional existing stablecoin address (devUSDC.e)>
 *       ETHERSCAN_API_KEY=<optional explorer API key for contract verification>
 *
 *   - Run:
 *       npx hardhat run --network cronos_testnet deploy/scripts/deploy.ts
 *
 * What this script does:
 *   - Optionally deploys a mintable ERC20 (devUSDC mock) when STABLE_TOKEN is not provided.
 *   - Deploys: PaymentVerifier, SalarySchedule, PayrollVault.
 *   - Wires contracts together (vault <-> schedule, verifier set on vault).
 *   - Writes deployment addresses to `deploy/deployments/<network>.json`.
 *   - Optionally attempts contract verification with the configured explorer API key.
 *
 * Notes / Assumptions:
 *   - If you want to use an existing devUSDC.e on Cronos testnet, set STABLE_TOKEN env var.
 *   - This script uses the OpenZeppelin preset ERC20 if STABLE_TOKEN isn't provided. Ensure
 *     `@openzeppelin/contracts` is available in node_modules (install via npm/yarn).
 *
 * Security:
 *   - Never commit your private key. Use CI secrets for automated deployments.
 */

import hre from "hardhat";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const {
  ethers,
  run,
  network,
} = hre;

async function main() {
  const networkName = network.name || "unknown";
  console.log(`\nDeploying BlockWage contracts to network: ${networkName}\n`);

  // Deployer signer
  let signer;
  const accounts = await ethers.getSigners();
  signer = accounts[0];
  console.log(`Using deployer: ${await signer.getAddress()}`);

  // Determine stable token address to use
  const envStableToken = process.env.STABLE_TOKEN && process.env.STABLE_TOKEN.trim() !== "" ? process.env.STABLE_TOKEN.trim() : undefined;
  let stableTokenAddress = envStableToken;

  // If no STABLE_TOKEN provided, deploy a mintable ERC20PresetMinterPauser as a devUSDC mock
  if (!stableTokenAddress) {
    console.log("No STABLE_TOKEN env var provided - deploying test ERC20 token (DevUSDC mock)...");
    // Use OpenZeppelin ERC20PresetMinterPauser when available
    // Fully qualified name: @openzeppelin/contracts/token/ERC20/presets/ERC20PresetMinterPauser.sol:ERC20PresetMinterPauser
    const useOZPreset = true;
    if (useOZPreset) {
      const tokenFactory = await ethers.getContractFactory(
        "@openzeppelin/contracts/token/ERC20/presets/ERC20PresetMinterPauser.sol:ERC20PresetMinterPauser",
        signer
      );
      const token = await tokenFactory.deploy("Dev USDC", "dUSDC");
      await token.deployed();
      stableTokenAddress = token.address;
      console.log(`Deployed DevUSDC mock at: ${stableTokenAddress}`);

      // Mint a small supply to deployer to enable deposits during demo / automated flows
      try {
        const mintAmount = ethers.parseUnits("10000", 6); // 10k USDC (6 decimals)
        // The OZ preset exposes `mint` to accounts with MINTER_ROLE; the deployer has that role by default with the preset.
        const tx = await token.mint(await signer.getAddress(), mintAmount);
        await tx.wait();
        console.log(`Minted ${mintAmount.toString()} tokens to deployer for testing.`);
      } catch (err) {
        // Not critical - if mint fails (role differences) the user can mint manually
        console.warn("Warning: failed to mint tokens to deployer (you may need to mint manually):", (err as Error).message);
      }
    } else {
      throw new Error("No STABLE_TOKEN provided and preset disabled - cannot proceed");
    }
  } else {
    console.log(`Using provided STABLE_TOKEN address: ${stableTokenAddress}`);
  }

  // Deploy PaymentVerifier
  console.log("\nDeploying PaymentVerifier...");
  const PaymentVerifier = await ethers.getContractFactory("PaymentVerifier", signer);
  const paymentVerifier = await PaymentVerifier.deploy();
  await paymentVerifier.deployed();
  console.log(`PaymentVerifier deployed at: ${paymentVerifier.address}`);

  // Deploy SalarySchedule with token address constructor argument
  console.log("\nDeploying SalarySchedule...");
  const SalarySchedule = await ethers.getContractFactory("SalarySchedule", signer);
  const salarySchedule = await SalarySchedule.deploy(stableTokenAddress);
  await salarySchedule.deployed();
  console.log(`SalarySchedule deployed at: ${salarySchedule.address}`);

  // Deploy PayrollVault(token, salarySchedule, paymentVerifier)
  console.log("\nDeploying PayrollVault...");
  const PayrollVault = await ethers.getContractFactory("PayrollVault", signer);
  const payrollVault = await PayrollVault.deploy(stableTokenAddress, salarySchedule.address, paymentVerifier.address);
  await payrollVault.deployed();
  console.log(`PayrollVault deployed at: ${payrollVault.address}`);

  // Wire SalarySchedule -> PayrollVault (if schedule expects it)
  try {
    const txSetVault = await salarySchedule.connect(signer).setPayrollVault(payrollVault.address);
    await txSetVault.wait();
    console.log("SalarySchedule.setPayrollVault(tx) succeeded.");
  } catch (err) {
    console.warn("SalarySchedule.setPayrollVault failed or not necessary:", (err as Error).message);
  }

  // Ensure PayrollVault has verifier set (constructor already set it, but ensure via setter if needed)
  try {
    const currentVerifierIsSet = true; // our constructor sets it already
    // If we needed to set:
    // await payrollVault.connect(signer).setPaymentVerifier(paymentVerifier.address);
    console.log("PayrollVault payment verifier already configured via constructor.");
  } catch (err) {
    console.warn("PayrollVault.setPaymentVerifier failed:", (err as Error).message);
  }

  // Print summary
  console.log("\nDeployment summary:");
  console.log("  Stable token:", stableTokenAddress);
  console.log("  PaymentVerifier:", paymentVerifier.address);
  console.log("  SalarySchedule:", salarySchedule.address);
  console.log("  PayrollVault:", payrollVault.address);
  console.log("");

  // Save to deployments file
  const deploymentsDir = path.join(process.cwd(), "deploy", "deployments");
  try {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  } catch (err) {
    // ignore
  }
  const outPath = path.join(deploymentsDir, `${networkName}.json`);
  const out = {
    network: networkName,
    deployedAt: new Date().toISOString(),
    stableToken: stableTokenAddress,
    paymentVerifier: paymentVerifier.address,
    salarySchedule: salarySchedule.address,
    payrollVault: payrollVault.address,
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote deployment info to: ${outPath}`);

  // Optional: attempt contract verification (requires ETHERSCAN_API_KEY and plugin configured)
  const etherscanApiKey = process.env.ETHERSCAN_API_KEY;
  if (etherscanApiKey && etherscanApiKey.length > 0) {
    console.log("\nETHERSCAN_API_KEY detected - attempting contract verification (may require explorer config for Cronos)...");
    // Attempt to verify each contract - this will succeed when network's explorer supports Etherscan verification and hardhat-etherscan is configured.
    // Note: constructor arguments must be provided exactly as used at deployment.
    try {
      await run("verify:verify", {
        address: paymentVerifier.address,
        constructorArguments: [],
      }).catch((e) => { console.warn("verify PaymentVerifier:", (e as Error).message); });

      await run("verify:verify", {
        address: salarySchedule.address,
        constructorArguments: [stableTokenAddress],
      }).catch((e) => { console.warn("verify SalarySchedule:", (e as Error).message); });

      await run("verify:verify", {
        address: payrollVault.address,
        constructorArguments: [stableTokenAddress, salarySchedule.address, paymentVerifier.address],
      }).catch((e) => { console.warn("verify PayrollVault:", (e as Error).message); });

      console.log("Verification attempts finished. Check explorer for contract sources.");
    } catch (err) {
      console.warn("Verification step failed (non-fatal):", (err as Error).message);
    }
  } else {
    console.log("\nNo ETHERSCAN_API_KEY provided - skipping contract verification step.");
  }

  console.log("\nDeployment finished.\n");
}

// Run main and handle errors
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
