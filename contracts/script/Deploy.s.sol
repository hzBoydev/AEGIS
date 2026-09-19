// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AegisVault.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address oracleAddress = vm.envAddress("ORACLE_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        AegisVault vault = new AegisVault(oracleAddress);

        console.log("AegisVault deployed at:", address(vault));
        console.log("Oracle address set to:", oracleAddress);

        vm.stopBroadcast();
    }
}
