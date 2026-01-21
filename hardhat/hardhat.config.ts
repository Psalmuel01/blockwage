import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";
import * as dotenv from "dotenv";
dotenv.config();

const CRONOS_TESTNET_RPC = "https://evm-t3.cronos.org";
const CRONOS_MAINNET_RPC = "https://evm.cronos.org";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
    cronos_test: {
      type: "http",
      chainType: "l1",
      chainId: 338,
      url: CRONOS_TESTNET_RPC,
      accounts: [configVariable("CRONOS_TEST_PRIVATE_KEY")],
    },
    cronos_main: {
      type: "http",
      chainType: "l1",
      chainId: 25,
      url: CRONOS_MAINNET_RPC,
      accounts: [configVariable("CRONOS_MAIN_PRIVATE_KEY")],
    },
  },
});
