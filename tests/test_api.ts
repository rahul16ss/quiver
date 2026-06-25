import { config } from "../src/config.js";
import picocolors from "picocolors";

async function testApi() {
  console.log(picocolors.cyan("\n📡 Testing LLM API Connectivity..."));
  console.log(`   Endpoint: ${config.llmBaseUrl}`);
  console.log(`   Model:    ${config.llmModelName}`);
  console.log(`   API Key:  ${config.llmApiKey ? "Present (length: " + config.llmApiKey.length + ")" : "None"}`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.llmApiKey) {
    headers["Authorization"] = `Bearer ${config.llmApiKey}`;
  }

  const payload = {
    model: config.llmModelName,
    messages: [
      { role: "user", content: "Say 'Hello from Quiver!' and nothing else." }
    ],
    max_tokens: 20,
    temperature: 0.1,
  };

  try {
    const startTime = Date.now();
    const response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(picocolors.red(`\n❌ API connection failed (status: ${response.status}):`));
      console.error(picocolors.red(errorText));
      return;
    }

    const data: any = await response.json();
    const result = data.choices?.[0]?.message?.content || "";
    console.log(picocolors.green(`\n✅ Connectivity successful! Received response in ${elapsed}s:`));
    console.log(`   > ${picocolors.bold(picocolors.magenta(result.trim()))}\n`);
  } catch (err: any) {
    console.error(picocolors.red(`\n❌ Connection failed: ${err.message}`));
  }
}

testApi();
