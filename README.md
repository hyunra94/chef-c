# 냉파 레시피 (chef-c)

냉장고 재료로 레시피를 추천받고, 부족한 재료는 쿠팡 링크로 바로 주문하는 웹앱.
https://hyunra.kr/chef-c/

## 구조
- **화면**: GitHub Pages (`index.html`, PWA)
- **DB·로그인**: Supabase 프로젝트 `chef-c` (이메일 로그인 링크)
- **AI**: Claude (냉장고 재료로 레시피 추천, SNS 본문·캡처에서 레시피 정리)
  - 기본: Edge Function `recommend`가 서버 키로 호출, 로그인 사용자당 하루 무료 횟수 제한
  - 선택: 사용자가 설정에서 자기 Claude 키를 넣으면 브라우저에서 바로 호출(서버를 거치지 않음), 횟수 제한 없음

## 테이블 (`supabase/migrations/001_init.sql`)
| 테이블 | 내용 | 권한 |
|---|---|---|
| ingredients | 냉장고 재료, 쿠팡 링크, 공개 PICK 여부 | 본인만. `is_pick`은 관리자만 켤 수 있음 |
| picks (view) | 공개 PICK 재료 이름·분류·링크 | 누구나 읽기 |
| recipes | 내 레시피 (SNS에서 가져온 레시피는 원본 링크 `source_url` 포함) | 본인만 |
| pantry | 기본 양념 | 본인만 |
| ai_usage | 하루 무료 추천 사용량 | 본인 읽기, Edge Function만 기록 |
| admins | 관리자 목록 | 직접 접근 불가 |

## Edge Function secrets
Supabase 대시보드 > Edge Functions > Secrets
- `ANTHROPIC_API_KEY` (필수)
- `CLAUDE_MODEL` (선택, 기본 `claude-haiku-4-5-20251001`)
- `DAILY_FREE_LIMIT` (선택, 기본 5)
- `ALLOWED_ORIGINS` (선택, 기본 `https://hyunra.kr,https://hyunra94.github.io`)

## 관리자 지정
처음 로그인한 뒤 SQL Editor에서:
```sql
insert into public.admins (user_id)
select id from auth.users where email = '내 이메일';
```
