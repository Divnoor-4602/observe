#!/usr/bin/env sh
# Regenerate observe_py/envelope.py from the cross-language contract.
# Run after `bun run generate` whenever the zod source changes; commit the result.
set -eu
cd "$(dirname "$0")/.."
uvx --from datamodel-code-generator datamodel-codegen \
	--input ../schemas/wide-event.schema.json \
	--input-file-type jsonschema \
	--output observe_py/envelope.py \
	--output-model-type pydantic_v2.BaseModel \
	--target-python-version 3.12 \
	--use-standard-collections \
	--use-union-operator \
	--allow-extra-fields \
	--disable-timestamp \
	--class-name WideEvent
echo "wrote observe_py/envelope.py"
