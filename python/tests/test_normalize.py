"""Golden conformance for normalize + the non-JSON coercions specified in
``docs/python-port.md`` (which fixtures cannot carry)."""

from __future__ import annotations

import copy
import math
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from observe_py.normalize import MAX_FIELDS, MAX_STRING, normalize

from .conftest import load_fixture


@pytest.mark.parametrize(
    "pair",
    load_fixture("normalize.json"),
    ids=lambda pair: str(sorted(pair["input"].keys())[0]),
)
def test_normalize_agrees_with_ts(pair):
    live = copy.deepcopy(pair["input"])
    normalize(live)
    assert live == pair["output"]


def test_datetime_becomes_iso_string():
    moment = datetime(2026, 7, 24, 12, 0, 0, tzinfo=UTC)
    bag = {"ts_field": moment}
    normalize(bag)
    assert bag["ts_field"] == moment.isoformat()


def test_non_finite_floats_become_null():
    bag = {"a": math.nan, "b": math.inf, "c": -math.inf, "d": 1.5}
    normalize(bag)
    assert bag == {"a": None, "b": None, "c": None, "d": 1.5}


def test_bool_survives_and_stays_bool():
    bag = {"flag": True}
    normalize(bag)
    assert bag["flag"] is True


def test_big_int_stays_number():
    bag = {"big": 2**70}
    normalize(bag)
    assert bag["big"] == 2**70


def test_decimal_never_survives_as_decimal():
    bag = {"amount": Decimal("49.99"), "bad": Decimal("NaN")}
    normalize(bag)
    assert isinstance(bag["amount"], float)
    assert bag["bad"] is None


def test_non_scalar_leaves_dropped():
    bag = {"a_set": {1, 2}, "a_tuple": (1, 2), "a_fn": normalize, "kept": "x"}
    normalize(bag)
    assert bag == {"kept": "x"}


def test_none_is_kept():
    bag = {"explicit_null": None}
    normalize(bag)
    assert bag == {"explicit_null": None}


def test_string_cap():
    bag = {"long": "a" * (MAX_STRING + 1)}
    normalize(bag)
    assert bag["long"] == "a" * MAX_STRING + "…"
    assert len(bag["long"]) == MAX_STRING + 1


def test_field_cap():
    bag = {f"field_{index:03}": index for index in range(MAX_FIELDS + 10)}
    normalize(bag)
    assert len(bag) == MAX_FIELDS
