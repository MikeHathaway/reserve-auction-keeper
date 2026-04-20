// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Like, IAjnaPoolLike} from "../FlashArbExecutorBase.sol";
import {TestBase} from "./TestBase.sol";

interface IAjnaReservePoolLike is IAjnaPoolLike {
    function kickReserveAuction() external;
    function quoteTokenScale() external view returns (uint256);

    function reservesInfo()
        external
        view
        returns (
            uint256 liquidationBondEscrowed_,
            uint256 reserveAuctionUnclaimed_,
            uint256 reserveAuctionKicked_,
            uint256 lastKickedReserves_,
            uint256 totalInterestEarned_
        );
}

contract ReserveAuctionMainnetForkTest is TestBase {
    uint256 internal constant PINNED_FORK_BLOCK_TIMESTAMP = 1774916723;

    struct ReserveAuctionFixture {
        IAjnaReservePoolLike pool;
        address quoteToken;
        uint256 takeQuoteTokenRaw;
        uint256 takeAmount;
        uint256 unclaimedBefore;
    }

    address internal constant AJNA =
        0x9a96ec9B57Fb64FbC60B423d1f4da7691Bd35079;
    address internal constant AJNA_WETH_UNISWAP_POOL =
        0xB79323DDEd09EaBAE6366cE11c51EC53b3fcd57e;

    uint256 internal constant TARGET_TAKE_QUOTE_TOKEN_RAW = 1_000_000; // 1 USDC
    uint256 internal constant FUND_AJNA_AMOUNT = 10_000 ether;

    function test_takeReserves_directFillWorksAgainstLiveMainnetAuction() public {
        vm.warp(PINNED_FORK_BLOCK_TIMESTAMP);

        address[10] memory candidatePools = [
            address(0x9cdB48FcBd8241Bb75887AF04d3b1302c410F671),
            address(0xE4BfB9b344A0Ae89702184281F13A295F3D49e15),
            address(0x2Ceb74Bb7a92D652C850C16F48547aa49F8bca31),
            address(0x3BA6A019eD5541b5F5555d8593080042Cf3ae5f4),
            address(0xE300B3A6b24cB3c5c87034155F7ffF7F77C862a0),
            address(0x66ea46C6e7F9e5BB065bd3B1090FFF229393BA51),
            address(0xc8f9750cDc473a17559225A8C958d229aD0D9c04),
            address(0xfe33ecd5758A34e4a3D0E9F746aec428B7638E78),
            address(0x2fEeF99A711D684E00a017C4AC587bea31F12875),
            address(0x304375E4890146DC575B894b35a42608FaB823a8)
        ];

        ReserveAuctionFixture memory fixture = _selectKickableReserveAuctionFixture(candidatePools);

        assertTrue(
            address(fixture.pool) != address(0),
            "no kickable reserve auction with whole quote units found on pinned fork"
        );
        assertTrue(
            fixture.unclaimedBefore >= fixture.takeAmount,
            "selected auction should cover the requested take amount"
        );

        vm.prank(AJNA_WETH_UNISWAP_POOL);
        assertTrue(
            IERC20Like(AJNA).transfer(address(this), FUND_AJNA_AMOUNT),
            "failed to source AJNA from live Uniswap pool"
        );

        uint256 ajnaBalanceBefore = IERC20Like(AJNA).balanceOf(address(this));
        uint256 quoteBalanceBefore = IERC20Like(fixture.quoteToken).balanceOf(address(this));

        assertTrue(
            IERC20Like(AJNA).approve(address(fixture.pool), type(uint256).max),
            "approve failed"
        );

        uint256 received = fixture.pool.takeReserves(fixture.takeAmount);

        uint256 ajnaBalanceAfter = IERC20Like(AJNA).balanceOf(address(this));
        uint256 quoteBalanceAfter = IERC20Like(fixture.quoteToken).balanceOf(address(this));
        (, uint256 unclaimedAfter, , , ) = fixture.pool.reservesInfo();

        assertEq(received, fixture.takeAmount, "pool should return the filled internal quote amount");
        assertEq(
            quoteBalanceAfter - quoteBalanceBefore,
            fixture.takeQuoteTokenRaw,
            "caller should receive live quote tokens in raw ERC20 units"
        );
        assertTrue(
            ajnaBalanceAfter < ajnaBalanceBefore,
            "caller should spend AJNA into the live reserve auction"
        );
        assertTrue(
            unclaimedAfter < fixture.unclaimedBefore,
            "active auction should consume unclaimed reserves after the live fill"
        );
    }

    function _selectKickableReserveAuctionFixture(
        address[10] memory candidatePools
    ) internal returns (ReserveAuctionFixture memory fixture) {
        for (uint256 i = 0; i < candidatePools.length; ++i) {
            IAjnaReservePoolLike candidatePool = IAjnaReservePoolLike(candidatePools[i]);
            uint256 candidateQuoteScale = candidatePool.quoteTokenScale();

            try candidatePool.kickReserveAuction() {
                (, uint256 candidateUnclaimedAfterKick, uint256 candidateKickedAt, , ) =
                    candidatePool.reservesInfo();

                if (candidateUnclaimedAfterKick / candidateQuoteScale == 0) continue;
                if (candidateKickedAt == 0) continue;

                uint256 candidateTakeQuoteTokenRaw =
                    candidateUnclaimedAfterKick / candidateQuoteScale;
                fixture.pool = candidatePool;
                fixture.quoteToken = candidatePool.quoteTokenAddress();
                fixture.takeQuoteTokenRaw =
                    candidateTakeQuoteTokenRaw < TARGET_TAKE_QUOTE_TOKEN_RAW
                        ? candidateTakeQuoteTokenRaw
                        : TARGET_TAKE_QUOTE_TOKEN_RAW;
                fixture.takeAmount = fixture.takeQuoteTokenRaw * candidateQuoteScale;
                fixture.unclaimedBefore = candidateUnclaimedAfterKick;
                return fixture;
            } catch {}
        }
    }
}
