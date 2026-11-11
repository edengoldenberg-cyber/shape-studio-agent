import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const indexPath = path.join(__dirname, '../public/index.html');
let content = fs.readFileSync(indexPath, 'utf8');
const lines = content.split('\n');

// Lines 410-582 (0-indexed) are the old Tomer section comment+section
const before = lines.slice(0, 410).join('\n');
const after  = lines.slice(583).join('\n');

const newSection = `    <!-- ═══════════════════════════════════════════════════
         TOMER — Member Service Workspace
    ════════════════════════════════════════════════════════ -->
    <section id="tab-tomer" class="tab-panel">
      <div id="tomer-ws">

        <!-- ── Workspace nav bar ─────────────────────────────── -->
        <div class="tw-topbar" dir="rtl">
          <div class="tw-tabs">
            <button class="tw-tab active" data-pane="overview">סקירה</button>
            <button class="tw-tab" data-pane="members">חברים</button>
            <button class="tw-tab" data-pane="tasks">תורים לעדן <span class="tw-badge" id="tw-badge-tasks"></span></button>
            <button class="tw-tab" data-pane="automation">אוטומציה</button>
            <button class="tw-tab" data-pane="audit">ביקורת</button>
          </div>
          <div class="tw-actions">
            <button class="btn btn-secondary" id="tw-refresh" title="רענן">🔄</button>
            <button class="btn btn-primary" id="btn-tomer-checks">▶ הרץ בדיקות</button>
            <div id="tomer-checks-result" class="tool-result" style="display:none"></div>
          </div>
        </div>

        <!-- ── Overview pane ─────────────────────────────────── -->
        <div class="tw-pane active" id="twp-overview" dir="rtl">
          <div class="tw-kpi-row" id="tw-kpis">
            <div class="tw-kpi"><span class="tw-kpi-val" id="twk-open">—</span><span class="tw-kpi-lbl">משימות פתוחות</span></div>
            <div class="tw-kpi urgent"><span class="tw-kpi-val" id="twk-high">—</span><span class="tw-kpi-lbl">עדיפות גבוהה</span></div>
            <div class="tw-kpi"><span class="tw-kpi-val" id="twk-unclass">—</span><span class="tw-kpi-lbl">לא מזוהים</span></div>
            <div class="tw-kpi"><span class="tw-kpi-val" id="twk-failed">—</span><span class="tw-kpi-lbl">פעולות נכשלו</span></div>
            <div class="tw-kpi"><span class="tw-kpi-val" id="twk-arbox">—</span><span class="tw-kpi-lbl">Arbox</span></div>
          </div>

          <div class="tw-two-col">
            <div class="tw-card">
              <div class="tw-card-title">🔴 מחכים לעדן</div>
              <div id="tw-open-tasks-list" class="tw-list"></div>
              <div class="tw-empty" id="tw-tasks-empty" style="display:none">אין משימות פתוחות</div>
            </div>
            <div class="tw-card">
              <div class="tw-card-title">📋 פעילות אחרונה</div>
              <div id="tw-recent-audit" class="tw-list"></div>
            </div>
          </div>

          <div class="tw-card" style="margin-top:12px">
            <div class="tw-card-title">❓ לא מזוהים — ממתינים לניתוב
              <span class="tw-badge-sm" id="tw-unclass-count"></span>
            </div>
            <div id="tw-unclassified-list" class="tw-list"></div>
            <div class="tw-empty" id="tw-unclass-empty">אין מספרים לא מזוהים</div>
          </div>
        </div>

        <!-- ── Members pane ───────────────────────────────────── -->
        <div class="tw-pane" id="twp-members" dir="rtl">
          <div class="tw-search-row">
            <input type="search" id="tw-member-search" placeholder="חפש לפי שם או טלפון..." class="field-input" style="max-width:280px"/>
            <select id="tw-member-status" class="field-input" style="max-width:160px">
              <option value="">כל הסטטוסים</option>
              <option value="active">פעיל</option>
              <option value="expiring">עומד לפוג</option>
              <option value="expired">פג תוקף</option>
            </select>
            <button class="btn btn-secondary" id="tw-members-load">טען מ-Arbox</button>
          </div>
          <div class="table-wrapper" style="margin-top:10px">
            <table class="leads-table">
              <thead><tr>
                <th>שם</th><th>טלפון (מוסתר)</th><th>סטטוס</th><th>תוקף מנוי</th>
                <th>בעלות</th><th>בקשה פתוחה</th><th></th>
              </tr></thead>
              <tbody id="tw-members-tbody"><tr><td colspan="7" class="empty-state">לחץ "טען מ-Arbox" לטעינת חברים</td></tr></tbody>
            </table>
          </div>
        </div>

        <!-- ── Eden Tasks pane ────────────────────────────────── -->
        <div class="tw-pane" id="twp-tasks" dir="rtl">
          <div class="tw-filter-row">
            <button class="filter-btn active" data-tf="open">פתוח</button>
            <button class="filter-btn" data-tf="eden_assigned">הוקצה לעדן</button>
            <button class="filter-btn" data-tf="resolved">נפתר</button>
            <button class="filter-btn" data-tf="">הכל</button>
          </div>
          <div class="table-wrapper" style="margin-top:10px">
            <table class="leads-table">
              <thead><tr>
                <th>חבר/ה</th><th>סוג</th><th>תקציר</th>
                <th>עדיפות</th><th>סטטוס</th><th>נוצר</th><th>פעולות</th>
              </tr></thead>
              <tbody id="tw-tasks-tbody"><tr><td colspan="7" class="empty-state">אין משימות</td></tr></tbody>
            </table>
          </div>
        </div>

        <!-- ── Automation pane ────────────────────────────────── -->
        <div class="tw-pane" id="twp-automation" dir="rtl">
          <p class="tw-desc">כל הווקפלואים מושבתים כברירת מחדל. הפעל לאחר בדיקת קהל, טקסט, וזמינות שעות שקטות.</p>
          <div id="tw-workflows" class="tw-workflow-list"></div>
          <button class="btn btn-secondary" id="tw-workflows-load" style="margin-top:12px">טען קונפיגורציה</button>
        </div>

        <!-- ── Audit pane ──────────────────────────────────────── -->
        <div class="tw-pane" id="twp-audit" dir="rtl">
          <div class="tw-filter-row">
            <input type="search" id="tw-audit-phone" placeholder="סינון לפי טלפון..." class="field-input" style="max-width:220px"/>
            <button class="btn btn-secondary" id="tw-audit-load">טען</button>
          </div>
          <div class="table-wrapper" style="margin-top:10px">
            <table class="leads-table">
              <thead><tr>
                <th>זמן</th><th>חבר/ה</th><th>אירוע</th><th>בקשה</th><th>פעולה</th><th>תגובה</th><th>Arbox</th>
              </tr></thead>
              <tbody id="tw-audit-tbody"><tr><td colspan="7" class="empty-state">לחץ "טען" לראות ביקורת</td></tr></tbody>
            </table>
          </div>
        </div>

        <!-- ── Member detail drawer ───────────────────────────── -->
        <div id="tw-drawer" class="tw-drawer" style="display:none" dir="rtl">
          <div class="tw-drawer-overlay" id="tw-drawer-overlay"></div>
          <div class="tw-drawer-panel">
            <div class="tw-drawer-header">
              <span id="tw-drawer-name">פרופיל חבר/ה</span>
              <button class="tw-drawer-close" id="tw-drawer-close">✕</button>
            </div>
            <div class="tw-drawer-body" id="tw-drawer-body">
              <div class="tw-spin">טוען...</div>
            </div>
          </div>
        </div>

        <!-- ── Floating admin chat ────────────────────────────── -->
        <div class="tw-chat-bubble" id="tw-chat-toggle" title="שוחח עם תומר">💬</div>
        <div class="tw-chat-panel" id="tw-chat-panel" style="display:none" dir="rtl">
          <div class="tw-chat-title">שוחח עם תומר <button class="tw-drawer-close" id="tw-chat-close">✕</button></div>
          <div class="mini-chat-msgs" id="tomer-chat-msgs"></div>
          <div class="mini-chat-row">
            <input type="text" id="tomer-chat-input" class="field-input" placeholder="שאל את תומר..." autocomplete="off"/>
            <button class="mini-send-btn" id="tomer-send">›</button>
          </div>
        </div>

      </div>
    </section>`;

const newContent = before + '\n' + newSection + '\n' + after;
fs.writeFileSync(indexPath, newContent);
console.log('Done. Total lines:', newContent.split('\n').length);
