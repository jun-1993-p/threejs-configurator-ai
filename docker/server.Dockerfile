# 업로드 서버(server/). 서버가 저장소 루트 기준으로 schema/를 읽으므로 /app에 같은 배치로 둔다.
FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY server ./server
COPY schema ./schema
# 편집 설치라 server/가 /app에 남고, schema/를 저장소와 같은 상대 경로로 찾는다
RUN pip install --no-cache-dir -e .

EXPOSE 8000
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
