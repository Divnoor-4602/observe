"""Golden conformance for sampling + unit ports of ``src/core/test/sample.test.ts``."""

from __future__ import annotations

import pytest

from observe_py.sample import get_sample_decision, is_sampled, resolve_sample_rate

from .conftest import load_fixture

SAMPLING = load_fixture("sampling.json")


@pytest.mark.parametrize(
    "case",
    SAMPLING["cases"],
    ids=lambda case: f"{case['trace_id'][:8]}@{case['rate']}",
)
def test_sampling_agrees_with_ts(case):
    assert is_sampled(case["trace_id"], case["rate"]) is case["should_keep"]


def test_rate_bounds():
    assert is_sampled("ffffffff" + "0" * 24, 1) is True
    assert is_sampled("00000000" + "0" * 24, 0) is False


def test_malformed_trace_id_keeps():
    assert is_sampled("not-hex!", 0.01) is True
    assert is_sampled("", 0.01) is True


def test_errors_always_kept():
    event = {"outcome": "error", "trace_id": "ffffffff" + "0" * 24}
    decision = get_sample_decision(event, 0.0, ())
    assert decision.should_keep is True
    assert decision.sample_rate == 1


def test_exempt_tiers_always_kept():
    event = {"outcome": "success", "trace_id": "ffffffff" + "0" * 24, "user_tier": "premium"}
    decision = get_sample_decision(event, 0.0, ("premium",))
    assert decision.should_keep is True
    assert decision.sample_rate == 1


def test_non_exempt_tier_uses_head_ratio():
    event = {"outcome": "success", "trace_id": "ffffffff" + "0" * 24, "user_tier": "free"}
    decision = get_sample_decision(event, 0.5, ("premium",))
    assert decision.should_keep is False
    assert decision.sample_rate == 0.5


def test_resolve_sample_rate():
    assert resolve_sample_rate(None) == 0.2
    assert resolve_sample_rate(1.5) == 1
    assert resolve_sample_rate(-1) == 0
    assert resolve_sample_rate(0.4) == 0.4
