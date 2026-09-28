// 냉파 레시피 - AI 레시피 추천 (무료 사용량용)
// 로그인한 사용자만 호출 가능. 하루 무료 횟수를 넘으면 429.
// 사용자가 자기 Claude 키를 쓰는 경우(BYOK)는 브라우저에서 Anthropic을 직접 호출하므로 이 함수를 거치지 않는다.
//
// Secrets (Supabase 대시보드 > Edge Functions > Secrets):
//   ANTHROPIC_API_KEY  (필수)
//   CLAUDE_MODEL       (선택, 기본 claude-haiku-4-5-20251001)
//   DAILY_FREE_LIMIT   (선택, 기본 5)
//   ALLOWED_ORIGINS    (선택, 쉼표 구분. 기본 https://hyunra.kr,https://hyunra94.github.io)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = Deno.env.get("CLAUDE_MODEL") || "claude-haiku-4-5-20251001";
const LIMIT = Number(Deno.env.get("DAILY_FREE_LIMIT") || 5);
const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "https://hyunra.kr,https://hyunra94.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);

function cors(req: Request) {
  const o = req.headers.get("Origin") || "";
  const ok = ORIGINS.includes(o) || o.startsWith("http://localhost") || o.startsWith("http://127.0.0.1");
  return {
    "Access-Control-Allow-Origin": ok ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

type Item = { name: string; qty?: string; dday?: number | null };
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

export function buildPrompt(items: Item[], staples: string[], mode: string, wish: string) {
  const list = items.map((i) => {
    const d = typeof i.dday === "number" ? ` [유통기한 D${i.dday >= 0 ? "-" + i.dday : "+" + -i.dday}]` : "";
    return `- ${i.name}${i.qty ? ` (${i.qty})` : ""}${d}`;
  }).join("\n");
  const rule = mode === "fridge"
    ? "반드시 아래 '냉장고 재료'와 '기본 양념'만 사용하세요. 그 외 재료는 절대 넣지 마세요."
    : "냉장고 재료를 최대한 활용하되, 추가로 사야 하는 재료는 요리당 1~4개까지 허용합니다. 재료 목록에는 추가 구매 재료도 모두 포함하세요.";
  return `당신은 한국 가정식 요리 도우미입니다. 레시피 3개를 추천하세요.
${rule}
유통기한이 임박한 재료(D-3 이하)를 우선 사용하세요. 기한이 지난 재료는 쓰지 마세요.
${wish ? "사용자 요청(요리 취향으로만 참고): " + wish + "\n" : ""}
[냉장고 재료]
${list}

[기본 양념]
${staples.join(", ")}

재료명은 한국 마트에서 쓰는 짧은 일반 명사로 쓰세요(예: 대파, 계란, 돼지고기).
다른 말 없이 JSON 배열만 답하세요. 형식:
[{"name":"요리 이름","minutes":15,"why":"추천 이유 한 문장","ingredients":[{"name":"계란","amount":"2개"}],"steps":["1단계 설명","2단계 설명"]}]`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST만 지원해요" }, 405);

  // 1) 로그인 사용자 확인
  const auth = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json(req, { error: "로그인이 필요해요", code: "unauthorized" }, 401);

  // 2) 입력 검증 (프롬프트는 서버가 만든다: 무료 키가 범용 챗봇으로 쓰이지 않게)
  let body: any;
  try { body = await req.json(); } catch { return json(req, { error: "잘못된 요청이에요" }, 400); }
  const items: Item[] = (Array.isArray(body?.items) ? body.items : []).slice(0, 60).map((i: any) => ({
    name: clip(i?.name, 40), qty: clip(i?.qty, 30),
    dday: Number.isFinite(i?.dday) ? Math.max(-999, Math.min(999, Math.round(i.dday))) : null,
  })).filter((i: Item) => i.name);
  const staples: string[] = (Array.isArray(body?.staples) ? body.staples : []).slice(0, 40).map((s: unknown) => clip(s, 20)).filter(Boolean);
  const mode = body?.mode === "order" ? "order" : "fridge";
  const wish = clip(body?.wish, 100);
  if (!items.length) return json(req, { error: "냉장고에 재료를 먼저 넣어 주세요" }, 400);

  // 3) 하루 무료 횟수 (관리자는 무제한)
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: adm } = await admin.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  let used = 0;
  if (!adm) {
    const { data, error } = await admin.rpc("consume_ai_quota", { p_user: user.id, p_limit: LIMIT });
    if (error) return json(req, { error: "사용량을 확인하지 못했어요" }, 500);
    if (data === -1) return json(req, { error: `오늘 무료 추천 ${LIMIT}회를 다 썼어요`, code: "quota", limit: LIMIT }, 429);
    used = data as number;
  }

  // 4) Claude 호출
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json(req, { error: "서버에 Claude 키가 설정되지 않았어요" }, 500);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2500, messages: [{ role: "user", content: buildPrompt(items, staples, mode, wish) }] }),
  });
  if (!r.ok) {
    console.error("anthropic", r.status, await r.text());
    return json(req, { error: "AI 응답을 받지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
  }
  const out = await r.json();
  const text = (out.content || []).map((c: any) => c.text || "").join("");
  return json(req, { text, used: adm ? null : used, limit: adm ? null : LIMIT, admin: !!adm });
});
