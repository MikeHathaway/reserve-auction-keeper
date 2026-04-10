// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { FlashArbExecutorV2V3 } from "../contracts/FlashArbExecutorV2V3.sol";

interface Vm {
    function envAddress(string calldata name) external returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract DeployFlashArbExecutorV2V3Script {
    Vm internal constant vm =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event FlashArbExecutorV2V3Deployed(
        address indexed executor,
        address indexed ajnaToken,
        address indexed swapRouter,
        address uniswapV2Factory
    );

    function run() external returns (FlashArbExecutorV2V3 executor) {
        address ajnaToken = vm.envAddress("FLASH_ARB_EXECUTOR_AJNA_TOKEN");
        address swapRouter = vm.envAddress("FLASH_ARB_EXECUTOR_SWAP_ROUTER");
        address uniswapV2Factory = vm.envAddress("FLASH_ARB_EXECUTOR_UNISWAP_V2_FACTORY");

        vm.startBroadcast();
        executor = new FlashArbExecutorV2V3(
            ajnaToken,
            swapRouter,
            uniswapV2Factory
        );
        vm.stopBroadcast();

        emit FlashArbExecutorV2V3Deployed(
            address(executor),
            ajnaToken,
            swapRouter,
            uniswapV2Factory
        );
    }
}
