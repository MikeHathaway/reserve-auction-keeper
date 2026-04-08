// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { FlashArbExecutor } from "../contracts/FlashArbExecutor.sol";

interface Vm {
    function envAddress(string calldata name) external returns (address);
    function envBytes32(string calldata name) external returns (bytes32);
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract DeployFlashArbExecutorScript {
    Vm internal constant vm =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event FlashArbExecutorDeployed(
        address indexed executor,
        address indexed ajnaToken,
        address indexed swapRouter,
        address uniswapV3Factory,
        bytes32 uniswapV3PoolInitCodeHash
    );

    function run() external returns (FlashArbExecutor executor) {
        address ajnaToken = vm.envAddress("FLASH_ARB_EXECUTOR_AJNA_TOKEN");
        address swapRouter = vm.envAddress("FLASH_ARB_EXECUTOR_SWAP_ROUTER");
        address uniswapV3Factory = vm.envAddress("FLASH_ARB_EXECUTOR_UNISWAP_V3_FACTORY");
        bytes32 uniswapV3PoolInitCodeHash = vm.envBytes32(
            "FLASH_ARB_EXECUTOR_UNISWAP_V3_POOL_INIT_CODE_HASH"
        );

        vm.startBroadcast();
        executor = new FlashArbExecutor(
            ajnaToken,
            swapRouter,
            uniswapV3Factory,
            uniswapV3PoolInitCodeHash
        );
        vm.stopBroadcast();

        emit FlashArbExecutorDeployed(
            address(executor),
            ajnaToken,
            swapRouter,
            uniswapV3Factory,
            uniswapV3PoolInitCodeHash
        );
    }
}
