"""Golden conformance for redaction + unit ports of ``src/core/test/redact.test.ts``."""

from __future__ import annotations

import pytest

from observe_py.redact import redact_event

from .conftest import load_fixture


@pytest.mark.parametrize(
    "pair",
    load_fixture("redaction.json"),
    ids=lambda pair: pair["input"]["event"] + ":" + str(sorted(pair["input"].keys())[0]),
)
def test_redaction_agrees_with_ts(pair):
    assert redact_event(pair["input"]) == pair["output"]


def test_input_event_is_not_mutated():
    event = {"password": "hunter2", "note": "email jane@example.com", "nested": {"cvv": "123"}}
    redact_event(event)
    assert event == {
        "password": "hunter2",
        "note": "email jane@example.com",
        "nested": {"cvv": "123"},
    }


def test_token_suffix_dropped_but_token_counts_survive():
    scrubbed = redact_event(
        {"access_token": "x", "refresh_token": "y", "tokens_in": 5, "tokens_out": 6}
    )
    assert "access_token" not in scrubbed
    assert "refresh_token" not in scrubbed
    assert scrubbed["tokens_in"] == 5
    assert scrubbed["tokens_out"] == 6


def test_luhn_invalid_numbers_survive():
    scrubbed = redact_event({"memo": "order 1234567890123 shipped"})
    assert scrubbed["memo"] == "order 1234567890123 shipped"


def test_non_string_leaves_pass_through():
    scrubbed = redact_event({"count": 3, "ratio": 0.5, "flag": True, "nothing": None})
    assert scrubbed == {"count": 3, "ratio": 0.5, "flag": True, "nothing": None}
