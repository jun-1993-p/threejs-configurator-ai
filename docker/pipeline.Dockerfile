# 파이프라인 실행 도구(configurator/). 파이프라인이 ../../schema, ../../data를 읽으므로 /app에 저장소와 같은 배치로 둔다.
FROM node:24-slim

WORKDIR /app/configurator
COPY configurator/package.json configurator/package-lock.json ./
# 조립이 실행 중에 esbuild로 번들을 만들므로 개발 의존성도 설치한다
RUN npm ci
COPY configurator/ ./
COPY schema /app/schema

ENTRYPOINT ["node"]
