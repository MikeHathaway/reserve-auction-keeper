// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockUniswapV3Pool} from "./MockUniswapV3Pool.sol";

contract MockUniswapV3Factory {
    struct Parameters {
        address token0;
        address token1;
        uint24 fee;
        uint256 fee0;
        uint256 fee1;
    }

    Parameters public parameters;

    function createPool(
        address token0,
        address token1,
        uint24 fee,
        uint256 fee0,
        uint256 fee1
    ) external returns (address pool) {
        parameters = Parameters({
            token0: token0,
            token1: token1,
            fee: fee,
            fee0: fee0,
            fee1: fee1
        });

        bytes32 salt = keccak256(abi.encode(token0, token1, fee));
        pool = address(new MockUniswapV3Pool{salt: salt}());

        delete parameters;
    }
}
