"""Golden conformance: envelope fixtures + catalog validation (docs/python-port.md DoD)."""

from __future__ import annotations

import jsonschema
import pytest
from pydantic import ValidationError

from observe_py.wide_event import validate_wide_event

from .conftest import load_fixture, load_schema


@pytest.mark.parametrize("fixture", load_fixture("envelope-valid.json"))
def test_valid_envelopes_pass(fixture):
    validate_wide_event(fixture)


@pytest.mark.parametrize("fixture", load_fixture("envelope-invalid.json"))
def test_invalid_envelopes_fail(fixture):
    with pytest.raises((ValidationError, ValueError)):
        validate_wide_event(fixture)


def test_unknown_event_names_are_valid():
    envelope = dict(load_fixture("envelope-valid.json")[0])
    envelope["event"] = "never_seen_before"
    envelope["custom_field"] = {"nested_value": 1}
    validate_wide_event(envelope)


def test_duration_rejects_string_coercion():
    envelope = dict(load_fixture("envelope-valid.json")[0])
    envelope["duration_ms"] = "42"
    with pytest.raises(ValidationError):
        validate_wide_event(envelope)


def test_error_extras_are_stripped():
    envelope = dict(load_fixture("envelope-valid.json")[0])
    envelope["error"] = {"stack": "secret", "type": "X"}
    validated = validate_wide_event(envelope)
    assert validated.error is not None
    assert validated.error.model_dump() == {"code": None, "message": None, "type": "X"}


def test_root_extras_are_kept():
    envelope = dict(load_fixture("envelope-valid.json")[0])
    envelope["custom_field"] = "kept"
    validated = validate_wide_event(envelope)
    assert validated.model_dump()["custom_field"] == "kept"


def test_chat_turn_validates_against_catalog_schema():
    catalog = load_schema("catalog.schema.json")
    chat_turn = next(
        fixture
        for fixture in load_fixture("envelope-valid.json")
        if fixture["event"] == "chat_turn" and "gen_ai" in fixture
    )
    jsonschema.validate(instance=chat_turn, schema=catalog["events"]["chat_turn"])


def test_catalog_rejects_wrong_field_types():
    catalog = load_schema("catalog.schema.json")
    chat_turn = next(
        dict(fixture)
        for fixture in load_fixture("envelope-valid.json")
        if fixture["event"] == "chat_turn" and "gen_ai" in fixture
    )
    chat_turn["gen_ai"] = {"usage": {"input_tokens": "not a number"}}
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=chat_turn, schema=catalog["events"]["chat_turn"])
