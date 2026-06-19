(function () {
  async function complete(input) {
    const response = await fetch("/api/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input || {}),
    });
    const payload = await response.json().catch(function () {
      return {};
    });
    if (!response.ok) {
      var fallback = "评审 Agent 调用失败。";
      try {
        if (window.TuttiI18n) {
          fallback = window.TuttiI18n.t(
            window.TuttiI18n.normalize(document.documentElement.lang),
            "agent.callFailed"
          );
        }
      } catch (e) {}
      throw new Error(payload.error || fallback);
    }
    return payload.text || "";
  }

  window.claude = Object.assign({}, window.claude, { complete: complete });
})();
