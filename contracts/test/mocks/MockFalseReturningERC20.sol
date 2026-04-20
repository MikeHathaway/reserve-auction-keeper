// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Malicious ERC20 that returns `false` from approve/transfer/transferFrom
// instead of reverting. Used to verify the executor's `_safeTokenCall` rejects
// the false-decoded-bool path with `InvalidAddress` rather than silently
// accepting the failure as success.
contract MockFalseReturningERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address, uint256) external pure returns (bool) {
        return false;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}
