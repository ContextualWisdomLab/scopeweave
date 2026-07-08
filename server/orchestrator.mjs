// contextual-orchestrator(LLM 오케스트레이션) 클라이언트.
// 실서버: ORCHESTRATOR_URL + ORCHESTRATOR_TOKEN 설정 시 OpenAI 호환
// /v1/chat/completions 호출. 미설정 시 결정적 MOCK으로 전 플로우 테스트 가능.
import { config } from './config.mjs';

const OC_URL = config.orchestrator.url;
const OC_TOKEN = config.orchestrator.token;

export const orchestratorMock = !OC_URL;

export async function chat(messages) {
  if (orchestratorMock) {
    const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    return `[mock-orchestrator] 분석 요약: ${user.slice(0, 120)}…에 대한 모의 응답입니다. `
      + '리스크: 지연 작업을 우선 점검하세요. 권고: 임계경로 작업의 담당자 부하를 재배분하세요.';
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`${OC_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(OC_TOKEN ? { authorization: `Bearer ${OC_TOKEN}` } : {}),
      },
      // orchestrator는 알 수 없는 필드를 거부(strict validation) — model+messages만 전송.
      body: JSON.stringify({ model: 'contextual-orchestrator', messages }),
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
