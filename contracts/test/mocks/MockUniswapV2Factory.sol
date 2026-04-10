// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockUniswapV2Pair} from "./MockUniswapV2Pair.sol";

contract MockUniswapV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "IDENTICAL");
        (address token0, address token1) =
            tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(getPair[token0][token1] == address(0), "EXISTS");

        MockUniswapV2Pair createdPair = new MockUniswapV2Pair(token0, token1);
        pair = address(createdPair);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
    }
}
