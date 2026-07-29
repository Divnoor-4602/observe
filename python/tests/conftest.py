from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from observe_py.client import ObservabilityClient
from observe_py.sinks import MemorySink
from observe_py.types import ClientConfig

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
SCHEMAS = Path(__file__).resolve().parents[2] / "schemas"


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


def load_schema(name: str) -> Any:
    return json.loads((SCHEMAS / name).read_text())


def deterministic_random_bytes(count: int) -> bytes:
    return bytes(range(1, count + 1))


@pytest.fixture
def memory_sink() -> MemorySink:
    return MemorySink()


@pytest.fixture
def client(memory_sink: MemorySink) -> ObservabilityClient:
    return ObservabilityClient(
        ClientConfig(environment="production", sample_rate=1, sinks=(memory_sink,))
    )
