/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { GoogleGenAI, Type } from "@google/genai";
import { StrategicHint, AiResponse, DebugInfo } from "../types";

// Initialize Gemini Client
let ai: GoogleGenAI | null = null;

if (process.env.API_KEY) {
    ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
} else {
    console.error("API_KEY is missing from environment variables.");
}

const MODEL_NAME = "gemini-3-flash-preview";

export interface TargetCandidate {
  id: string;
  color: string;
  size: number;
  row: number;
  col: number;
  pointsPerBubble: number;
  description: string;
}

// Maps for AI Context
const COLOR_LABELS: Record<string, string> = {
    red: "사과 (Apple)",
    blue: "버스 (Bus)",
    green: "기차 (Train)",
    yellow: "사자 (Lion)",
    purple: "포도 (Grape)",
    orange: "오렌지 (Orange)"
};

export const getStrategicHint = async (
  imageBase64: string,
  validTargets: TargetCandidate[], // Now contains candidates for ALL colors
  dangerRow: number
): Promise<AiResponse> => {
  const startTime = performance.now();
  
  // Default debug info container
  const debug: DebugInfo = {
    latency: 0,
    screenshotBase64: imageBase64, // Keep the raw input for display
    promptContext: "",
    rawResponse: "",
    timestamp: new Date().toLocaleTimeString()
  };

  if (!ai) {
    return {
        hint: { message: "API 키가 없습니다." },
        debug: { ...debug, error: "API Key Missing" }
    };
  }

  // Local Heuristic Fallback
  const getBestLocalTarget = (msg: string = "확실한 단어가 안 보여요. 조심하세요!"): StrategicHint => {
    if (validTargets.length > 0) {
        // Sort by Total Potential Score (Size * Value) then Height
        const best = validTargets.sort((a,b) => {
            const scoreA = a.size * a.pointsPerBubble;
            const scoreB = b.size * b.pointsPerBubble;
            return (scoreB - scoreA) || (a.row - b.row);
        })[0];
        
        return {
            message: `[${COLOR_LABELS[best.color] || best.color.toUpperCase()}]를 맞춰보세요!`,
            rationale: "Selected based on highest potential cluster score available locally.",
            targetRow: best.row,
            targetCol: best.col,
            recommendedColor: best.color as any
        };
    }
    return { message: msg, rationale: "No valid clusters found to target." };
  };

  const hasDirectTargets = validTargets.length > 0;

  const targetListStr = hasDirectTargets 
    ? validTargets.map(t => 
        `- OPTION: Select ${t.color.toUpperCase()} [${COLOR_LABELS[t.color] || ''}] -> Target [Row ${t.row}, Col ${t.col}]. Cluster Size: ${t.size}.`
      ).join("\n")
    : "NO MATCHES AVAILABLE. Suggest a color to set up a future combo.";
  
  debug.promptContext = targetListStr;

  const prompt = `
    당신은 친절한 어린이 한글 선생님입니다.
    학생이 한글 단어가 적힌 구슬을 맞추는 게임을 하고 있습니다.
    
    ### 단어 목록 (WORD MAPPING)
    - Red: 사과 (Apple)
    - Blue: 버스 (Bus)
    - Green: 기차 (Train)
    - Yellow: 사자 (Lion)
    - Purple: 포도 (Grape)
    - Orange: 오렌지 (Orange)

    ### 게임 상태 (GAME STATE)
    - Danger Level: ${dangerRow >= 6 ? "CRITICAL (구슬이 바닥에 닿으려 해요!)" : "Stable"}
    
    ### 가능한 움직임 (AVAILABLE MOVES)
    ${targetListStr}

    ### 당신의 임무
    화면과 가능한 움직임을 보고 학생에게 조언해주세요.
    1. 학생이 맞춰야 할 가장 좋은 단어(색깔)를 고르세요.
    2. 학생에게 그 단어를 찾으라고 한국어로 말해주세요. (초등학교 1~2학년 수준)
    
    우선순위:
    1. **학습**: 같은 단어가 많이 뭉쳐있는 곳을 찾도록 유도하세요.
    2. **생존**: 만약 Danger Level이 CRITICAL이라면, 단어와 상관없이 가장 아래에 있는 구슬을 없애라고 하세요.

    ### 응답 형식 (JSON)
    Markdown을 사용하지 말고 오직 JSON만 반환하세요.
    JSON 구조:
    {
      "message": "짧은 지시 (예: '사과를 찾아보세요!')",
      "rationale": "이유 설명 (예: '사과를 없애면 포도도 같이 떨어질 거예요.')",
      "recommendedColor": "red|blue|green|yellow|purple|orange",
      "targetRow": integer,
      "targetCol": integer
    }
  `;

  try {
    // Strip the data:image/png;base64, prefix if present
    const cleanBase64 = imageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: {
        parts: [
            { text: prompt },
            { 
              inlineData: {
                mimeType: "image/png",
                data: cleanBase64
              } 
            }
        ]
      },
      config: {
        maxOutputTokens: 2048, // Increased to ensure full JSON response
        temperature: 0.4,
        responseMimeType: "application/json" 
      }
    });

    const endTime = performance.now();
    debug.latency = Math.round(endTime - startTime);
    
    let text = response.text || "{}";
    debug.rawResponse = text;
    
    // Robust JSON Extraction: 
    // Isolate the substring between the first '{' and the last '}'
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        text = text.substring(firstBrace, lastBrace + 1);
    } 

    try {
        const json = JSON.parse(text);
        debug.parsedResponse = json;
        
        const r = Number(json.targetRow);
        const c = Number(json.targetCol);
        
        if (!isNaN(r) && !isNaN(c) && json.recommendedColor) {
            return {
                hint: {
                    message: json.message || "좋은 자리가 있어요!",
                    rationale: json.rationale,
                    targetRow: r,
                    targetCol: c,
                    recommendedColor: json.recommendedColor.toLowerCase()
                },
                debug
            };
        }
        return {
            hint: getBestLocalTarget("AI가 위치를 잘못 알려줬어요."),
            debug: { ...debug, error: "Invalid Coordinates in JSON" }
        };

    } catch (e: any) {
        console.warn("Failed to parse Gemini JSON:", text);
        return {
            hint: getBestLocalTarget("AI 응답을 이해하지 못했어요."),
            debug: { ...debug, error: `JSON Parse Error: ${e.message}` }
        };
    }
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    const endTime = performance.now();
    debug.latency = Math.round(endTime - startTime);
    return {
        hint: getBestLocalTarget("AI 선생님과 연결이 끊겼어요."),
        debug: { ...debug, error: error.message || "Unknown API Error" }
    };
  }
};