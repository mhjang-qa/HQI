const state = {
  projects: [],
  trend: [],
};

const $ = (id) => document.getElementById(id);
const fmtPct = (value) => `${Math.round((value || 0) * 100)}%`;
const fmtCases = (project) => (project.testCaseBase > 0 ? `${project.executedCases}/${project.testCaseBase}` : "미집계");
const KST_TIME_ZONE = "Asia/Seoul";

function normalizeDateInput(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
    return `${text.replace(" ", "T")}+09:00`;
  }
  return text;
}

function scoreClass(score) {
  if (score >= 85) return "good";
  if (score >= 70) return "warn";
  return "bad";
}

function formatKstDateTime(value) {
  if (!value) return "-";
  const date = new Date(normalizeDateInput(value));
  if (Number.isNaN(date.getTime())) return String(value).replace("T", " ");
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: KST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day} ${lookup.hour}:${lookup.minute}:${lookup.second}`;
}

function normalizeProjectStatus(status) {
  const text = String(status || "").trim().toLowerCase();
  if (!text) return "-";
  if (text.includes("완료") || text.includes("done")) return "완료";
  if (text.includes("진행")) return "진행 중";
  return status;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 3600);
}

function filteredProjects() {
  const query = $("search").value.trim().toLowerCase();
  return state.projects.filter((project) => {
    const haystack = `${project.project} ${project.name} ${project.category}`.toLowerCase();
    return haystack.includes(query);
  });
}

async function readApiJson(response, fallbackMessage) {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${fallbackMessage}: 서버가 JSON이 아닌 응답을 반환했습니다.`);
  }
  if (!response.ok) {
    throw new Error(data.message || fallbackMessage);
  }
  return data;
}

async function loadDashboard({ silent = false } = {}) {
  if (!silent) {
    $("refreshButton").disabled = true;
    $("refreshButton").textContent = "갱신 중";
  }
  try {
    const response = await fetch("./embed-data.json", { cache: "no-store" });
    const data = await readApiJson(response, "저장 결과 조회 실패");
    state.projects = data.projects;
    state.trend = data.regularTrend || [];
    renderRows();
    renderTrend();
  $("generatedAt").textContent = formatKstDateTime(data.generatedAt);
  } catch (error) {
    if (!silent) showToast(error.message);
  } finally {
    if (!silent) {
      $("refreshButton").disabled = false;
      $("refreshButton").textContent = "수동 갱신";
    }
  }
}

function renderRows() {
  const rows = filteredProjects();
  $("projectRows").innerHTML = rows.length
    ? rows.map(renderProjectRow).join("")
    : '<tr><td colspan="9" class="empty">저장된 계산 결과가 없습니다.</td></tr>';
}

function renderTrend() {
  const items = state.trend;
  const maxScore = Math.max(1, ...items.map((item) => item.score || 0));
  $("trendChart").innerHTML = items.length
    ? items
        .map((item) => {
          const width = Math.max(2, Math.round(((item.score || 0) / maxScore) * 100));
          return `
            <div class="embedTrendRow">
              <span class="embedTrendVersion">${escapeHtml(item.project)}</span>
              <div class="embedTrendTrack">
                <div class="embedTrendFill ${scoreClass(item.score)}" style="width: ${width}%"></div>
              </div>
              <span class="embedTrendScore">${item.score}</span>
            </div>
          `;
        })
        .join("")
    : '<div class="empty">5.18 이후 정기 업데이트 계산 결과가 없습니다.</div>';
}

function renderProjectRow(project) {
  return `
    <tr>
      <td>
        <strong>${escapeHtml(project.project)}</strong><br />
        <small>${escapeHtml(project.category)} · ${escapeHtml(project.date || "-")}</small>
      </td>
      <td><span class="score ${scoreClass(project.score)}">${project.score}</span></td>
      <td class="metric">${fmtPct(project.TPR)}</td>
      <td class="metric">${fmtPct(project.DQS)}</td>
      <td class="metric">${fmtPct(project.BOR)}</td>
      <td class="metric">${fmtPct(project.BFR)}</td>
      <td class="metric">${fmtCases(project)}</td>
      <td class="metric">${project.bugCount} / 미해결 ${project.openBugCount}</td>
      <td>${escapeHtml(normalizeProjectStatus(project.status))}</td>
    </tr>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

$("search").addEventListener("input", renderRows);
$("refreshButton").addEventListener("click", () => loadDashboard());
loadDashboard();
