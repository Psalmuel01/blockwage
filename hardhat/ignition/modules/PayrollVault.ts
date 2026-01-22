import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("PayrollVaultModule", (m) => {
  const payrollVault = m.contract("PayrollVault", [
    "0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0", // devUSDC.e on Cronos testnet
    "0x08A8Ab9Ae12e4fF3967626a14a83CE3B12FE0102", // SalarySchedule contract address
  ]);

  return { payrollVault };
});
