// contextual-orchestrator(LLM 오케스트레이션) 클라이언트.
// 실서버: ORCHESTRATOR_URL + ORCHESTRATOR_TOKEN 설정 시 OpenAI 호환
// /v1/chat/completions 호출. 미설정 시 결정적 MOCK으로 전 플로우 테스트 가능.
const OC_URL = (process.env.ORCHESTRATOR_URL || '').replace(/\/$/, '');
const OC_TOKEN = process.env.ORCHESTRATOR_TOKEN || '';

export const orchestratorMock = !OC_URL;

// orchestrator는 알 수 없는 필드를 거부(strict validation)하지만 attribution은
// 명시적으로 허용된 필드다(ATTRIBUTION_DIMENSIONS: account/service/upstream_api/
// model_name/team/group/company, + provider 별칭). 값을 넘기지 않으면 해당 호출은
// orchestrator 비용 원장에서 "unattributed"로 집계된다.
const ATTRIBUTION_DIMENSIONS = new Set([
  'account', 'service', 'upstream_api', 'model_name', 'team', 'group', 'company', 'provider',
]);

function sanitizeAttribution(attribution) {
  if (!attribution || typeof attribution !== 'object') return undefined;
  const entries = Object.entries(attribution).filter(
    ([key, value]) => ATTRIBUTION_DIMENSIONS.has(key) && value != null && String(value).length > 0,
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
}

export async function chat(messages, attribution) {
  if (orchestratorMock) {
    const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    return `[mock-orchestrator] 분석 요약: ${user.slice(0, 120)}…에 대한 모의 응답입니다. `
      + '리스크: 지연 작업을 우선 점검하세요. 권고: 임계경로 작업의 담당자 부하를 재배분하세요.';
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 60000);
  try {
    const cleanAttribution = sanitizeAttribution(attribution);
    const res = await fetch(`${OC_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(OC_TOKEN ? { authorization: `Bearer ${OC_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        model: 'contextual-orchestrator',
        messages,
        ...(cleanAttribution ? { attribution: cleanAttribution } : {}),
      }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    const content = data?.choices?.[0]?.message?.content;
    if (!res.ok || !content) throw new Error(data?.error?.message || `orchestrator failed (${res.status})`);
    return content;
  } finally {
    clearTimeout(to);
  }
}
