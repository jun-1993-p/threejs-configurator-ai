"""서버 실행: uvicorn server.main:app --host 0.0.0.0 --port 8000

실제 상품 데이터가 공개 저장소에 올라가지 않도록, 기본 저장 위치는 .gitignore 대상이다.
"""

import os
from pathlib import Path

from server.app import create_app

app = create_app(
    data_dir=Path(os.environ.get("CONFIGURATOR_DATA_DIR", "data")),
    recordings_dir=Path(os.environ.get("CONFIGURATOR_RECORDINGS_DIR", "fixtures/private/recordings")),
)
