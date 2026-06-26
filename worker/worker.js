/**
 * 냉장고를 부탁해 - Cloudflare Worker
 * 역할: Claude / Gemini AI API 프록시 + Notion DB CRUD
 *
 * 환경변수 (wrangler secret put 으로 설정):
 *   CLAUDE_API_KEY   - Anthropic API 키
 *   GEMINI_API_KEY   - Google Gemini API 키
 *   NOTION_TOKEN     - Notion Integration 토큰
 *   NOTION_INGREDIENT_DB - 재료 DB ID
 *   NOTION_RECIPE_DB     - 레시피 DB ID
 *   ALLOWED_ORIGIN   - 허용할 프론트엔드 도메인 (예: https://hyunra94.github.io)
 */

// ============================================================
//   CORS 헬퍼
// ============================================================
function corsHeaders(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || '*';
  // 개발 편의상 localhost도 허용
  const isAllowed =
    allowed === '*' ||
    origin === allowed ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1');

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Provider, X-Model',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonRes(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function errRes(msg, status = 400, headers = {}) {
  return jsonRes({ error: msg }, status, headers);
}

// ============================================================
//   MAIN HANDLER
// ============================================================
export default {
  async fetch(req, env) {
    const cors = corsHeaders(env, req);

    // Preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ── AI 레시피 추천 ──────────────────────────────────
      if (path === '/api/recipe' && req.method === 'POST') {
        return await handleRecipe(req, env, cors);
      }

      // ── Notion: 재료 ────────────────────────────────────
      if (path === '/api/ingredients') {
        if (req.method === 'GET')    return await getIngredients(req, env, cors);
        if (req.method === 'POST')   return await createIngredient(req, env, cors);
      }
      if (path.startsWith('/api/ingredients/')) {
        const id = path.replace('/api/ingredients/', '');
        if (req.method === 'PUT')    return await updateIngredient(req, env, cors, id);
        if (req.method === 'DELETE') return await deleteIngredient(req, env, cors, id);
      }

      // ── Notion: 저장 레시피 ─────────────────────────────
      if (path === '/api/saved-recipes') {
        if (req.method === 'GET')    return await getSavedRecipes(req, env, cors);
        if (req.method === 'POST')   return await createSavedRecipe(req, env, cors);
      }
      if (path.startsWith('/api/saved-recipes/')) {
        const id = path.replace('/api/saved-recipes/', '');
        if (req.method === 'PUT')    return await updateSavedRecipe(req, env, cors, id);
        if (req.method === 'DELETE') return await deleteSavedRecipe(req, env, cors, id);
      }

      // ── Health check ────────────────────────────────────
      if (path === '/api/health') {
        return jsonRes({
          ok: true,
          services: {
            claude:  !!env.CLAUDE_API_KEY,
            gemini:  !!env.GEMINI_API_KEY,
            openai:  !!env.OPENAI_API_KEY,
            notion:  !!(env.NOTION_TOKEN && env.NOTION_INGREDIENT_DB),
          }
        }, 200, cors);
      }

      return errRes('Not found', 404, cors);

    } catch (e) {
      console.error(e);
      return errRes(e.message || 'Internal Server Error', 500, cors);
    }
  }
};

// ============================================================
//   AI RECIPE (Claude / Gemini)
// ============================================================
async function handleRecipe(req, env, cors) {
  const body = await req.json();
  const { prompt, provider = 'claude', model } = body;

  if (!prompt) return errRes('prompt 필드가 없습니다', 400, cors);

  if (provider === 'gemini') {
    return await callGemini(prompt, model, env, cors);
  } else if (provider === 'gpt') {
    return await callGPT(prompt, model, env, cors);
  } else {
    return await callClaude(prompt, model, env, cors);
  }
}

// ── Claude ──
async function callClaude(prompt, model, env, cors) {
  const key = env.CLAUDE_API_KEY;
  if (!key) return errRes('CLAUDE_API_KEY 환경변수가 설정되지 않았습니다', 500, cors);

  const claudeModel = model || 'claude-sonnet-4-6';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: claudeModel,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok) return errRes(data.error?.message || 'Claude API 오류', res.status, cors);

  const text = data.content?.[0]?.text || '';
  return jsonRes({ text, provider: 'claude', model: claudeModel }, 200, cors);
}

// ── Gemini ──
async function callGemini(prompt, model, env, cors) {
  const key = env.GEMINI_API_KEY;
  if (!key) return errRes('GEMINI_API_KEY 환경변수가 설정되지 않았습니다', 500, cors);

  const geminiModel = model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2000 },
    }),
  });

  const data = await res.json();
  if (!res.ok) return errRes(data.error?.message || 'Gemini API 오류', res.status, cors);

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return jsonRes({ text, provider: 'gemini', model: geminiModel }, 200, cors);
}

// ── ChatGPT (OpenAI) ──
async function callGPT(prompt, model, env, cors) {
  const key = env.OPENAI_API_KEY;
  if (!key) return errRes('OPENAI_API_KEY 환경변수가 설정되지 않았습니다', 500, cors);

  const gptModel = model || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: gptModel,
      max_tokens: 2000,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok) return errRes(data.error?.message || 'ChatGPT API 오류', res.status, cors);

  const text = data.choices?.[0]?.message?.content || '';
  return jsonRes({ text, provider: 'gpt', model: gptModel }, 200, cors);
}

// ============================================================
//   NOTION 공통 헬퍼
// ============================================================
async function notionRequest(env, method, endpoint, body = null) {
  const token = env.NOTION_TOKEN;
  if (!token) throw new Error('NOTION_TOKEN 환경변수가 설정되지 않았습니다');

  const res = await fetch(`https://api.notion.com/v1${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Notion API 오류');
  return data;
}

// Notion 속성 추출 헬퍼
function prop(page, key) {
  const p = page.properties?.[key];
  if (!p) return null;
  switch (p.type) {
    case 'title':        return p.title?.[0]?.plain_text || '';
    case 'rich_text':    return p.rich_text?.[0]?.plain_text || '';
    case 'number':       return p.number ?? null;
    case 'select':       return p.select?.name || '';
    case 'date':         return p.date?.start || '';
    case 'checkbox':     return p.checkbox ?? false;
    case 'multi_select': return p.multi_select?.map(s => s.name) || [];
    default:             return null;
  }
}

// ============================================================
//   재료 CRUD
// ============================================================
async function getIngredients(req, env, cors) {
  const dbId = env.NOTION_INGREDIENT_DB;
  if (!dbId) return errRes('NOTION_INGREDIENT_DB 환경변수가 없습니다', 500, cors);

  const data = await notionRequest(env, 'POST', `/databases/${dbId}/query`, {
    sorts: [{ property: '입력일', direction: 'descending' }],
    filter: { property: '삭제됨', checkbox: { equals: false } },
  });

  const ingredients = (data.results || []).map(pageToIngredient);
  return jsonRes({ ingredients }, 200, cors);
}

async function createIngredient(req, env, cors) {
  const dbId = env.NOTION_INGREDIENT_DB;
  if (!dbId) return errRes('NOTION_INGREDIENT_DB 환경변수가 없습니다', 500, cors);

  const body = await req.json();
  const page = await notionRequest(env, 'POST', '/pages', {
    parent: { database_id: dbId },
    properties: ingredientToProps(body),
  });

  return jsonRes({ ingredient: pageToIngredient(page) }, 201, cors);
}

async function updateIngredient(req, env, cors, pageId) {
  const body = await req.json();
  const page = await notionRequest(env, 'PATCH', `/pages/${pageId}`, {
    properties: ingredientToProps(body),
  });
  return jsonRes({ ingredient: pageToIngredient(page) }, 200, cors);
}

async function deleteIngredient(req, env, cors, pageId) {
  // 소프트 삭제: 삭제됨 체크박스 ON
  await notionRequest(env, 'PATCH', `/pages/${pageId}`, {
    properties: { '삭제됨': { checkbox: true } },
  });
  return jsonRes({ ok: true }, 200, cors);
}

// Notion Page → JS 객체
function pageToIngredient(page) {
  return {
    id: page.id,
    name:    prop(page, '재료명'),
    cat:     prop(page, '카테고리'),
    emoji:   prop(page, '이모지'),
    qty:     prop(page, '수량'),
    unit:    prop(page, '단위'),
    addDate: prop(page, '입력일'),
    expiry:  prop(page, '유통기한'),
    checked: prop(page, '레시피선택'),
  };
}

// JS 객체 → Notion Properties
function ingredientToProps(d) {
  const props = {};
  if (d.name)    props['재료명']    = { title:      [{ text: { content: d.name } }] };
  if (d.cat)     props['카테고리']  = { select:     { name: d.cat } };
  if (d.emoji)   props['이모지']    = { rich_text:  [{ text: { content: d.emoji } }] };
  if (d.qty != null) props['수량']  = { number: d.qty };
  if (d.unit)    props['단위']      = { rich_text:  [{ text: { content: d.unit } }] };
  if (d.addDate) props['입력일']    = { date: { start: d.addDate } };
  if (d.expiry)  props['유통기한']  = { date: { start: d.expiry } };
  props['레시피선택'] = { checkbox: !!d.checked };
  props['삭제됨']     = { checkbox: false };
  return props;
}

// ============================================================
//   저장 레시피 CRUD
// ============================================================
async function getSavedRecipes(req, env, cors) {
  const dbId = env.NOTION_RECIPE_DB;
  if (!dbId) return errRes('NOTION_RECIPE_DB 환경변수가 없습니다', 500, cors);

  const data = await notionRequest(env, 'POST', `/databases/${dbId}/query`, {
    sorts: [{ property: '저장일', direction: 'descending' }],
  });

  const recipes = (data.results || []).map(pageToRecipe);
  return jsonRes({ recipes }, 200, cors);
}

async function createSavedRecipe(req, env, cors) {
  const dbId = env.NOTION_RECIPE_DB;
  if (!dbId) return errRes('NOTION_RECIPE_DB 환경변수가 없습니다', 500, cors);

  const body = await req.json();
  const page = await notionRequest(env, 'POST', '/pages', {
    parent: { database_id: dbId },
    properties: recipeToProps(body),
    // 레시피 스텝은 본문 블록으로 저장
    children: stepsToBlocks(body.steps || []),
  });

  return jsonRes({ recipe: pageToRecipe(page) }, 201, cors);
}

async function updateSavedRecipe(req, env, cors, pageId) {
  const body = await req.json();
  const page = await notionRequest(env, 'PATCH', `/pages/${pageId}`, {
    properties: recipeToProps(body),
  });
  return jsonRes({ recipe: pageToRecipe(page) }, 200, cors);
}

async function deleteSavedRecipe(req, env, cors, pageId) {
  await notionRequest(env, 'DELETE', `/pages/${pageId}`);
  return jsonRes({ ok: true }, 200, cors);
}

function pageToRecipe(page) {
  return {
    id:               page.id,
    title:            prop(page, '레시피명'),
    emoji:            prop(page, '이모지'),
    time:             prop(page, '조리시간'),
    difficulty:       prop(page, '난이도'),
    ingredients_used: prop(page, '사용재료'),
    tip:              prop(page, '팁'),
    why:              prop(page, '추천이유'),
    savedAt:          prop(page, '저장일'),
    reviewRating:     prop(page, '별점'),
    reviewText:       prop(page, '리뷰'),
    provider:         prop(page, 'AI제공자'),
  };
}

function recipeToProps(d) {
  const props = {};
  if (d.title)   props['레시피명']  = { title:     [{ text: { content: d.title } }] };
  if (d.emoji)   props['이모지']    = { rich_text: [{ text: { content: d.emoji } }] };
  if (d.time)    props['조리시간']  = { rich_text: [{ text: { content: d.time } }] };
  if (d.difficulty) props['난이도'] = { select:    { name: d.difficulty } };
  if (d.ingredients_used?.length)
    props['사용재료'] = { multi_select: d.ingredients_used.map(n => ({ name: n })) };
  if (d.tip)     props['팁']        = { rich_text: [{ text: { content: d.tip } }] };
  if (d.why)     props['추천이유']  = { rich_text: [{ text: { content: d.why } }] };
  if (d.savedAt) props['저장일']    = { date:      { start: d.savedAt } };
  if (d.review?.rating != null)
    props['별점']  = { number: d.review.rating };
  if (d.review?.text)
    props['리뷰']  = { rich_text: [{ text: { content: d.review.text } }] };
  if (d.provider) props['AI제공자'] = { select: { name: d.provider } };
  return props;
}

// 조리 스텝을 Notion 본문 블록으로 변환
function stepsToBlocks(steps) {
  return steps.map((step, i) => ({
    object: 'block',
    type: 'numbered_list_item',
    numbered_list_item: {
      rich_text: [{ type: 'text', text: { content: step } }],
    },
  }));
}
