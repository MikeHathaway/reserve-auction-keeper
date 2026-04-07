// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

struct Log {
    bytes32[] topics;
    bytes data;
    address emitter;
}

interface Vm {
    function prank(address caller) external;
    function expectRevert() external;
    function expectRevert(bytes calldata revertData) external;
    function warp(uint256 newTimestamp) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

abstract contract TestBase {
    Vm internal constant vm =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 left, uint256 right, string memory message) internal pure {
        require(left == right, message);
    }

    function assertEq(address left, address right, string memory message) internal pure {
        require(left == right, message);
    }

    function assertTrue(bool condition, string memory message) internal pure {
        require(condition, message);
    }
}
