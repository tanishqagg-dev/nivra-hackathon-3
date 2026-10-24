#!/bin/sh
set -eu
APP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_PATH="$APP_ROOT/../.venv-fight"
uv venv --python 3.11 --allow-existing "$ENV_PATH"
uv pip install --python "$ENV_PATH/bin/python" -r "$APP_ROOT/backend/requirements.txt"
cd "$APP_ROOT/backend"
"$ENV_PATH/bin/python" -c 'from detector import FightEnsemble; d = FightEnsemble(); print("Fight models ready:", d.device)'
