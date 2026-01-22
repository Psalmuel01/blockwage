import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("PayrollVaultModule", (m) => {
  const payrollVault = m.contract("PayrollVault", [
    "0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0", // devUSDC.e on Cronos testnet
    "0x3d722Cd3340444f6E0632e4eA55c1Cd57F18E67b", // SalarySchedule contract address
  ]);

  return { payrollVault };
});
