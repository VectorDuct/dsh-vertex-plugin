/** Native Plugins row configuration, using DSH's lazy browser module protocol. */
window.__ModuleLoader__.load({
  id: "dsh-vertex-json",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const NS = "vertexJson";
    const fields = [
      "project",
      "location",
      "maxOutputTokens",
      "temperature",
      "topP",
      "thinkingBudget",
      "thinkingLevel",
      "includeThoughts",
    ];
    const numeric = new Set([
      "maxOutputTokens",
      "temperature",
      "topP",
      "thinkingBudget",
    ]);
    const dictionaries = {
      en: {
        summary: "Connect your Google Cloud service account to Vertex AI.",
        credentials:
          "Import or remove your JSON key in Settings → Credentials → Vertex AI. Keys stay on the computer running DSH.",
        settings: "Vertex AI settings",
        project: "Project override",
        location: "Region override",
        maxOutputTokens: "Maximum output tokens",
        temperature: "Temperature",
        topP: "Top P",
        thinkingBudget: "Thinking token budget",
        thinkingLevel: "Thinking level",
        includeThoughts: "Show thinking summaries",
        inherit: "Use default",
        yes: "Yes",
        no: "No",
        models: "Additional Gemini model IDs (one per line)",
        modelsHint:
          "Optional. Listed models are not proof of access. Refresh retrieves the Google publisher catalog without generating content.",
        save: "Save settings",
        saving: "Saving…",
        saved: "Settings saved.",
        saveFailed: "Settings could not be saved. Reload and try again.",
        refresh: "Refresh model catalog",
        refreshing: "Refreshing…",
        refreshed: "Models listed: {count}. Access remains unverified.",
        refreshFailed:
          "Could not refresh models. Check your credential, project, region and permissions.",
        unavailable: "Configuration is loading or unavailable.",
        errorNumber: "Enter valid numbers or leave fields blank.",
        unsaved:
          "Save pending settings before refreshing. Blank overrides use the imported project and region.",
      },
      zh: {
        summary: "使用自己的 Google Cloud 服务账号连接 Vertex AI。",
        credentials:
          "请在「设置 → 凭据 → Vertex AI」导入或删除 JSON 密钥。密钥保存在运行 DSH 的电脑上。",
        settings: "Vertex AI 设置",
        project: "项目覆盖值",
        location: "区域覆盖值",
        maxOutputTokens: "最大输出 token 数",
        temperature: "温度",
        topP: "Top P",
        thinkingBudget: "思考 token 预算",
        thinkingLevel: "思考级别",
        includeThoughts: "显示思考摘要",
        inherit: "使用默认值",
        yes: "是",
        no: "否",
        models: "额外 Gemini 模型 ID（每行一个）",
        modelsHint:
          "可选。出现在目录中不代表具有调用权限。刷新仅获取 Google 发布商模型目录，不生成内容。",
        save: "保存设置",
        saving: "保存中…",
        saved: "设置已保存。",
        saveFailed: "保存失败，请重新加载后重试。",
        refresh: "刷新模型目录",
        refreshing: "刷新中…",
        refreshed: "已列出 {count} 个模型，调用权限仍未验证。",
        refreshFailed: "刷新失败，请检查凭据、项目、区域和权限。",
        unavailable: "设置正在加载或暂不可用。",
        errorNumber: "请输入有效数字，或留空。",
        unsaved: "刷新前请先保存设置。覆盖值留空时使用导入凭据时的项目和区域。",
      },
    };
    function draftOf(value = {}) {
      return Object.fromEntries([
        ...fields.map((key) => [
          key,
          value[key] === undefined ? "" : String(value[key]),
        ]),
        ["models", (value.models ?? []).map((model) => model.id).join("\n")],
      ]);
    }
    function Panel({ t, form, remote }) {
      const state = form?.state;
      const [draft, setDraft] = React.useState(() => draftOf(state?.value));
      const [busy, setBusy] = React.useState("");
      const [message, setMessage] = React.useState("");
      React.useEffect(() => {
        setDraft(draftOf(state?.value));
      }, [state?.revision]);
      const ready = state?.status === "ready";
      const edit = (key, value) => {
        setDraft((current) => ({ ...current, [key]: value }));
        setMessage("");
      };
      const dirty =
        JSON.stringify(draft) !== JSON.stringify(draftOf(state?.value));
      async function save(event) {
        event.preventDefault();
        if (!ready || !state.writable || busy) return;
        const ops = [];
        for (const key of fields) {
          const text = draft[key].trim();
          if (!text) {
            ops.push({ op: "unset", path: [key] });
            continue;
          }
          const value = numeric.has(key)
            ? Number(text)
            : key === "includeThoughts"
              ? text === "true"
              : text;
          if (numeric.has(key) && !Number.isFinite(value)) {
            setMessage(t("errorNumber"));
            return;
          }
          ops.push({ op: "set", path: [key], value });
        }
        const ids = [
          ...new Set(
            draft.models
              .split(/\r?\n/)
              .map((id) => id.trim())
              .filter(Boolean),
          ),
        ];
        const previous = state.value?.models ?? [];
        ops.push({
          op: "set",
          path: ["models"],
          value: ids.map(
            (id) => previous.find((model) => model.id === id) ?? { id },
          ),
        });
        setBusy("save");
        setMessage("");
        try {
          setMessage(
            t(
              (await form.mutate(ops, state.revision)) ? "saved" : "saveFailed",
            ),
          );
        } catch {
          setMessage(t("saveFailed"));
        } finally {
          setBusy("");
        }
      }
      async function refresh() {
        if (busy || dirty) return;
        setBusy("refresh");
        setMessage("");
        try {
          const result = await remote.llm.discoverModels("vertex-json", {
            provider: "vertex-json",
          });
          setMessage(
            result.ok
              ? t("refreshed").replace("{count}", String(result.value.length))
              : t("refreshFailed"),
          );
        } catch {
          setMessage(t("refreshFailed"));
        } finally {
          setBusy("");
        }
      }
      const select = (key, values) =>
        h(
          "select",
          {
            id: `vertex-${key}`,
            value: draft[key],
            disabled: !ready || !state.writable || !!busy,
            onChange: (event) => edit(key, event.target.value),
          },
          h("option", { value: "" }, t("inherit")),
          ...values.map(([value, label]) =>
            h("option", { key: value, value }, label),
          ),
        );
      return h(
        "form",
        {
          onSubmit: save,
          "aria-label": t("settings"),
          "data-vertex-settings": "",
          style: { display: "grid", gap: "12px", maxWidth: "640px" },
        },
        h("p", null, t("credentials")),
        !ready ? h("p", { role: "status" }, t("unavailable")) : null,
        ...fields.map((key) =>
          h(
            "div",
            { key, style: { display: "grid", gap: "4px" } },
            h("label", { htmlFor: `vertex-${key}` }, t(key)),
            key === "thinkingLevel"
              ? select(
                  key,
                  ["minimal", "low", "medium", "high"].map((value) => [
                    value,
                    value,
                  ]),
                )
              : key === "includeThoughts"
                ? select(key, [
                    ["true", t("yes")],
                    ["false", t("no")],
                  ])
                : h("input", {
                    id: `vertex-${key}`,
                    value: draft[key],
                    type: numeric.has(key) ? "number" : "text",
                    step: ["temperature", "topP"].includes(key)
                      ? "any"
                      : numeric.has(key)
                        ? "1"
                        : undefined,
                    placeholder: t("inherit"),
                    disabled: !ready || !state.writable || !!busy,
                    onChange: (event) => edit(key, event.target.value),
                  }),
          ),
        ),
        h("label", { htmlFor: "vertex-models" }, t("models")),
        h("textarea", {
          id: "vertex-models",
          rows: 4,
          value: draft.models,
          disabled: !ready || !state.writable || !!busy,
          onChange: (event) => edit("models", event.target.value),
        }),
        h("p", null, t("modelsHint")),
        h("p", null, t("unsaved")),
        h(
          "div",
          { style: { display: "flex", gap: "12px", flexWrap: "wrap" } },
          h(
            "button",
            {
              type: "submit",
              disabled: !ready || !state.writable || !!busy || !dirty,
            },
            t(busy === "save" ? "saving" : "save"),
          ),
          h(
            "button",
            {
              type: "button",
              disabled: !ready || !!busy || dirty,
              onClick: refresh,
            },
            t(busy === "refresh" ? "refreshing" : "refresh"),
          ),
        ),
        h("p", { role: "status", "aria-live": "polite" }, message),
      );
    }
    return {
      inject: ["slots", "locale", "remote"],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries));
        ctx.slots.inject("plugins.row.config", () =>
          ctx.slots.register(
            {
              name: "plugins.row.config",
              key: "dsh-vertex-json#vertex-json",
              locale: NS,
            },
            ({ t, view, form }) =>
              view === "summary"
                ? t("summary")
                : h(Panel, { t, form, remote: ctx.remote }),
          ),
        );
      },
    };
  },
});
