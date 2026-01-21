```Vibe Coding/blockwage/hardhat.config.ts#L1-200
/**
 * Hardhat configuration for BlockWage (Cronos / x402 Payroll)
 *
 * Usage:
 *  - Create a .env file at the project root with:
 *      DEPLOYER_PRIVATE_KEY=0x...
 *      CRONOS_TESTNET_RPC=https://evm-t3.cronos.org
 *  - Install deps:
 *      npm install --save-dev hardhat @nomiclabs/hardhat-ethers @nomiclabs/hardhat-waffle solidity-coverage dotenv ts-node typescript
 *
 * Notes:
 *  - This config targets solidity 0.8.17 with optimization enabled for production-like builds.
 *  - Network `cronos_testnet` defaults to Cronos t3 RPC; override via CRONOS_TESTNET_RPC env var.
 */

import { HardhatUserConfig } from "hardhat/types";
import "@nomiclabs/hardhat-ethers";
import "@nomiclabs/hardhat-waffle";
import "solidity-coverage";
import * as dotenv from "dotenv";

dotenv.config();

const CRONOS_TESTNET_RPC =
  process.env.CRONOS_TESTNET_RPC || "https://evm-t3.cronos.org";

/**
 * Cronos Testnet (t3) uses chainId 338.
 * If you are using a different Cronos testnet endpoint, adjust chainId accordingly.
 *
 * Provide the deployer private key in the environment variable:
 *   DEPLOYER_PRIVATE_KEY=0x...
 *
 * For CI, set these secrets in your runner's secret storage.
 */
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.17",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // Enable metadata bytecode hash minimization for reproducible builds if needed:
      // metadata: { bytecodeHash: "none" },
    },
  },

  networks: {
    hardhat: {
      // Useful for local testing & forking (if desired) - don't enable for CI by default
      chainId: 1337,
      // Uncomment to enable forking from Cronos testnet (requires RPC & INFOS)
      // forking: {
      //   url: CRONOS_TESTNET_RPC,
      // },
    },

    cronos_testnet: {
      url: CRONOS_TESTNET_RPC,
      // Cronos testnet (t3) chain id
      chainId: 338,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
  },

  paths: {
    sources: "contracts",
    tests: "test",
    cache: "cache",
    artifacts: "artifacts",
  },

  mocha: {
    timeout: 600000, // 10 minutes for potentially slow network tests
  },
};

export default config;
