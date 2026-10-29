# 24: SolidCraft 합성 녹화본

**What to build:** Fusion 실물 확인이 어려운 동안 쓸 합성 녹화본을 SolidCraft로 만든다. 스크립트가 `solidcraft-cli run`으로 SolidCraft 모델의 사용자 파라미터를 단독 스윕하고, 업로드 묶음 스키마(`schema/upload-bundle.schema.json`)에 맞는 파일을 낸다. 평면과 원기둥 면만 다룬다. 서버는 이 파일을 녹화본과 똑같이 받아들인다.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 스크립트가 `.sc` 모델 하나를 받아 사용자 파라미터마다 기본값 ±50% 5점 단독 스윕을 돌리고, 원본 모델은 바꾸지 않는다
- [ ] 사용자 파라미터가 아닌 스케치 치수(예: 서랍장의 서랍 높이 `d6`)도 이름을 넘기면 함께 스윕한다
- [ ] 결과 파일이 업로드 묶음 스키마 검사를 통과하고, 만든 도구가 `source: "solidcraft"`로 적힌다
- [ ] 면마다 SolidCraft의 면 이름을, 모서리마다 `면A|면B` 이름을 그대로 담는다
- [ ] 평면·원기둥이 아닌 면이 있으면 그 면 이름과 함께 오류를 내고 파일을 쓰지 않는다
- [ ] 샘플마다 부피와 바운딩 박스를 담는다(티켓 05의 `volume_jump`, 티켓 10의 위상 비교에 쓴다)
- [ ] `solidcraft-test/drawer.sc`로 만든 서랍장 합성 녹화본이 저장소에 있다

## Comments

- 근거: `solidcraft-test/report.md` 6절, ADR-0016. 점 배치는 티켓 25에서 경계 맞춤 격자로 바뀐다. 이 티켓에서는 면·모서리 이름과 경계 모서리 끝점을 빠짐없이 담는 데 집중한다.
- SolidCraft MCP는 허용 폴더 밖 쓰기를 막지만 `solidcraft-cli`는 그렇지 않다. 실행 파일: `C:\Program Files\SolidCraft\solidcraft-cli.exe`.
- `inspect.parameter_sweep`는 형상 오류를 ok로 보고하므로 쓰지 않는다. `parameters.change`로 값을 직접 바꾼다.
