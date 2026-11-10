# Собирает WinForms «Проверка сделок.exe» — мини-приложение без терминала.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path $root 'Проверка сделок.exe'

$code = @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

public static class Theme {
  public static readonly Color CanvasTop = Color.FromArgb(244, 248, 252);
  public static readonly Color CanvasBot = Color.FromArgb(226, 235, 245);
  public static readonly Color Surface = Color.White;
  public static readonly Color Ink = Color.FromArgb(18, 28, 44);
  public static readonly Color Muted = Color.FromArgb(95, 112, 136);
  public static readonly Color Line = Color.FromArgb(214, 224, 236);
  public static readonly Color Accent = Color.FromArgb(12, 110, 168);
  public static readonly Color AccentHot = Color.FromArgb(8, 88, 138);
  public static readonly Color AccentDeep = Color.FromArgb(5, 70, 114);
  public static readonly Color Ghost = Color.FromArgb(248, 251, 254);
  public static readonly Color GhostHot = Color.FromArgb(236, 243, 250);
  public static readonly Color LogBg = Color.FromArgb(24, 32, 46);
  public static readonly Color LogFg = Color.FromArgb(210, 222, 236);
  public static readonly Color OkBg = Color.FromArgb(226, 244, 234);
  public static readonly Color OkFg = Color.FromArgb(20, 108, 66);
  public static readonly Color RunBg = Color.FromArgb(228, 240, 252);
  public static readonly Color RunFg = Color.FromArgb(12, 88, 140);
  public static readonly Color WarnBg = Color.FromArgb(255, 241, 220);
  public static readonly Color WarnFg = Color.FromArgb(150, 88, 8);
}

public static class Draw {
  public static GraphicsPath Round(Rectangle r, int radius) {
    int d = Math.Max(2, radius * 2);
    var p = new GraphicsPath();
    p.AddArc(r.X, r.Y, d, d, 180, 90);
    p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    p.CloseFigure();
    return p;
  }
  public static void ApplyRound(Control c, int radius) {
    using (var path = Round(new Rectangle(0, 0, Math.Max(1, c.Width), Math.Max(1, c.Height)), radius)) {
      c.Region = new Region(path);
    }
  }
}

public class UiButton : Button {
  Color _base, _hover, _press;
  bool _over, _down;
  public bool IsPrimary;

  public UiButton(string text, bool primary) {
    Text = text;
    IsPrimary = primary;
    FlatStyle = FlatStyle.Flat;
    FlatAppearance.BorderSize = 0;
    Cursor = Cursors.Hand;
    Height = 44;
    Font = new Font("Segoe UI Semibold", 10.25f);
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    ApplyColors();
    Resize += (s, e) => Draw.ApplyRound(this, 11);
  }

  void ApplyColors() {
    if (IsPrimary) {
      _base = Theme.Accent; _hover = Theme.AccentHot; _press = Theme.AccentDeep;
      ForeColor = Color.White;
    } else {
      _base = Theme.Ghost; _hover = Theme.GhostHot; _press = Color.FromArgb(224, 232, 242);
      ForeColor = Theme.Ink;
    }
  }

  protected override void OnEnabledChanged(EventArgs e) {
    base.OnEnabledChanged(e);
    Invalidate();
  }
  protected override void OnMouseEnter(EventArgs e) { _over = true; Invalidate(); base.OnMouseEnter(e); }
  protected override void OnMouseLeave(EventArgs e) { _over = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
  protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) { _down = true; Invalidate(); } base.OnMouseDown(e); }
  protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }

  protected override void OnPaint(PaintEventArgs e) {
    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
    e.Graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
    Color fill = !Enabled ? Color.FromArgb(220, 228, 236) : (_down ? _press : (_over ? _hover : _base));
    Color text = !Enabled ? Color.FromArgb(140, 150, 165) : ForeColor;
    using (var path = Draw.Round(new Rectangle(0, 0, Width - 1, Height - 1), 11))
    using (var br = new SolidBrush(fill)) {
      e.Graphics.Clear(Parent != null ? Parent.BackColor : Theme.Surface);
      e.Graphics.FillPath(br, path);
      if (!IsPrimary && Enabled) {
        using (var pen = new Pen(Theme.Line)) e.Graphics.DrawPath(pen, path);
      }
    }
    TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, text,
      TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
  }
}

public class SoftCard : Panel {
  public SoftCard() {
    DoubleBuffered = true;
    BackColor = Theme.Surface;
    Resize += (s, e) => Draw.ApplyRound(this, 16);
  }
  protected override void OnPaintBackground(PaintEventArgs e) {
    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
    e.Graphics.Clear(Parent != null ? Parent.BackColor : Theme.CanvasTop);
    using (var path = Draw.Round(new Rectangle(0, 0, Width - 1, Height - 1), 16))
    using (var br = new SolidBrush(Theme.Surface))
    using (var pen = new Pen(Theme.Line)) {
      e.Graphics.FillPath(br, path);
      e.Graphics.DrawPath(pen, path);
    }
  }
}

public class StatusPill : Control {
  Color _bg = Theme.OkBg;
  Color _fg = Theme.OkFg;
  public StatusPill() {
    Height = 30;
    Font = new Font("Segoe UI Semibold", 9f);
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
  }
  public void SetState(string text, string kind) {
    Text = text;
    if (kind == "run") { _bg = Theme.RunBg; _fg = Theme.RunFg; }
    else if (kind == "warn") { _bg = Theme.WarnBg; _fg = Theme.WarnFg; }
    else { _bg = Theme.OkBg; _fg = Theme.OkFg; }
    Width = Math.Max(132, TextRenderer.MeasureText(Text, Font).Width + 28);
    Invalidate();
  }
  protected override void OnPaint(PaintEventArgs e) {
    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
    e.Graphics.Clear(Parent != null ? Parent.BackColor : Theme.CanvasTop);
    using (var path = Draw.Round(new Rectangle(0, 0, Width - 1, Height - 1), 15))
    using (var br = new SolidBrush(_bg)) {
      e.Graphics.FillPath(br, path);
    }
    TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, _fg,
      TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
  }
}

public class DealCheckerForm : Form {
  TextBox urlBox;
  RichTextBox logBox;
  UiButton startBtn;
  UiButton stopBtn;
  UiButton updateBtn;
  StatusPill statusPill;
  Process running;
  string appRoot;
  string nodePath;
  Panel headerHost;

  public DealCheckerForm(string root, string node) {
    appRoot = root;
    nodePath = node;
    Text = "Проверка сделок";
    Width = 920;
    Height = 700;
    MinimumSize = new Size(780, 580);
    StartPosition = FormStartPosition.CenterScreen;
    Font = new Font("Segoe UI", 10f);
    BackColor = Theme.CanvasTop;
    DoubleBuffered = true;

    Paint += (s, e) => {
      using (var br = new LinearGradientBrush(ClientRectangle, Theme.CanvasTop, Theme.CanvasBot, 105f))
        e.Graphics.FillRectangle(br, ClientRectangle);
      using (var accent = new LinearGradientBrush(new Rectangle(0, 0, 7, Height),
        Color.FromArgb(12, 110, 168), Color.FromArgb(64, 176, 198), 90f))
        e.Graphics.FillRectangle(accent, 0, 0, 7, Height);
    };

    headerHost = new Panel();
    headerHost.Left = 34;
    headerHost.Top = 26;
    headerHost.Width = ClientSize.Width - 68;
    headerHost.Height = 78;
    headerHost.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
    headerHost.BackColor = Color.Transparent;
    Controls.Add(headerHost);

    var brand = new Label();
    brand.Text = "Проверка сделок";
    brand.Font = new Font("Segoe UI Semibold", 24f, FontStyle.Bold);
    brand.ForeColor = Theme.Ink;
    brand.AutoSize = true;
    brand.Location = new Point(0, 0);
    brand.BackColor = Color.Transparent;
    headerHost.Controls.Add(brand);

    var sub = new Label();
    sub.Text = "Битрикс24  ·  только чтение  ·  Excel-отчёт";
    sub.Font = new Font("Segoe UI", 10.25f);
    sub.ForeColor = Theme.Muted;
    sub.AutoSize = true;
    sub.Location = new Point(2, 46);
    sub.BackColor = Color.Transparent;
    headerHost.Controls.Add(sub);

    updateBtn = new UiButton("Обновления", false);
    updateBtn.Width = 118;
    updateBtn.Height = 34;
    updateBtn.Top = 8;
    updateBtn.Click += async (s, e) => await CheckUpdates(true);
    headerHost.Controls.Add(updateBtn);

    statusPill = new StatusPill();
    statusPill.SetState("Готово к работе", "ok");
    statusPill.Top = 10;
    statusPill.Anchor = AnchorStyles.Top | AnchorStyles.Right;
    headerHost.Controls.Add(statusPill);
    headerHost.Resize += (s, e) => LayoutHeader();

    var card = new SoftCard();
    card.Left = 34;
    card.Top = 112;
    card.Width = ClientSize.Width - 68;
    card.Height = 156;
    card.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
    Controls.Add(card);

    var urlLabel = new Label();
    urlLabel.Text = "ССЫЛКА НА ОТЧЁТ CRM";
    urlLabel.Font = new Font("Segoe UI Semibold", 8.5f);
    urlLabel.ForeColor = Theme.Muted;
    urlLabel.AutoSize = true;
    urlLabel.Location = new Point(26, 22);
    urlLabel.BackColor = Theme.Surface;
    card.Controls.Add(urlLabel);

    var urlShell = new Panel();
    urlShell.Location = new Point(26, 48);
    urlShell.Size = new Size(card.Width - 52, 40);
    urlShell.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
    urlShell.BackColor = Color.FromArgb(248, 251, 254);
    urlShell.Padding = new Padding(12, 8, 12, 8);
    urlShell.Resize += (s, e) => Draw.ApplyRound(urlShell, 10);
    urlShell.Paint += (s, e) => {
      e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
      using (var path = Draw.Round(new Rectangle(0, 0, urlShell.Width - 1, urlShell.Height - 1), 10))
      using (var br = new SolidBrush(Color.FromArgb(248, 251, 254)))
      using (var pen = new Pen(Theme.Line)) {
        e.Graphics.FillPath(br, path);
        e.Graphics.DrawPath(pen, path);
      }
    };
    card.Controls.Add(urlShell);

    urlBox = new TextBox();
    urlBox.BorderStyle = BorderStyle.None;
    urlBox.Font = new Font("Segoe UI", 11.25f);
    urlBox.Dock = DockStyle.Fill;
    urlBox.BackColor = Color.FromArgb(248, 251, 254);
    urlBox.ForeColor = Theme.Ink;
    urlShell.Controls.Add(urlBox);

    startBtn = new UiButton("Запустить", true);
    startBtn.Width = 160;
    startBtn.Location = new Point(26, 98);
    startBtn.Click += async (s, e) => await StartCheck();
    card.Controls.Add(startBtn);

    stopBtn = new UiButton("Остановить", false);
    stopBtn.Width = 132;
    stopBtn.Location = new Point(198, 98);
    stopBtn.Enabled = false;
    stopBtn.Click += (s, e) => StopCheck();
    card.Controls.Add(stopBtn);

    var logCard = new SoftCard();
    logCard.Left = 34;
    logCard.Top = 284;
    logCard.Width = ClientSize.Width - 68;
    logCard.Height = ClientSize.Height - 318;
    logCard.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
    Controls.Add(logCard);

    var logTitle = new Label();
    logTitle.Text = "ХОД ПРОВЕРКИ";
    logTitle.Font = new Font("Segoe UI Semibold", 8.5f);
    logTitle.ForeColor = Theme.Muted;
    logTitle.AutoSize = true;
    logTitle.Location = new Point(26, 18);
    logTitle.BackColor = Theme.Surface;
    logCard.Controls.Add(logTitle);

    var logShell = new Panel();
    logShell.Location = new Point(22, 44);
    logShell.Size = new Size(logCard.Width - 44, logCard.Height - 66);
    logShell.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
    logShell.BackColor = Theme.LogBg;
    logShell.Resize += (s, e) => Draw.ApplyRound(logShell, 12);
    logCard.Controls.Add(logShell);

    logBox = new RichTextBox();
    logBox.BorderStyle = BorderStyle.None;
    logBox.ReadOnly = true;
    logBox.BackColor = Theme.LogBg;
    logBox.ForeColor = Theme.LogFg;
    try { logBox.Font = new Font("Cascadia Mono", 9.75f); }
    catch { logBox.Font = new Font("Consolas", 9.75f); }
    logBox.Location = new Point(14, 12);
    logBox.Width = logShell.Width - 28;
    logBox.Height = logShell.Height - 24;
    logBox.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
    logBox.DetectUrls = false;
    logShell.Controls.Add(logBox);

    FormClosing += (s, e) => {
      if (running != null && !running.HasExited) {
        try { running.Kill(); } catch { }
      }
    };

    Shown += (s, e) => {
      LayoutHeader();
      AppendLog("Папка: " + appRoot);
      AppendLog("Node: " + nodePath);
    };
  }

  void LayoutHeader() {
    statusPill.Left = Math.Max(0, headerHost.Width - statusPill.Width);
    updateBtn.Left = Math.Max(0, statusPill.Left - updateBtn.Width - 10);
  }

  void SetStatus(string text, string kind) {
    if (InvokeRequired) { BeginInvoke(new Action(() => SetStatus(text, kind))); return; }
    statusPill.SetState(text, kind);
    LayoutHeader();
  }

  void AppendLog(string line) {
    if (InvokeRequired) { BeginInvoke(new Action(() => AppendLog(line))); return; }
    if (logBox.TextLength > 200000) logBox.Clear();
    logBox.SelectionStart = logBox.TextLength;
    logBox.SelectionColor = Theme.LogFg;
    if (line.StartsWith("✗") || line.IndexOf("Ошибка", StringComparison.OrdinalIgnoreCase) >= 0)
      logBox.SelectionColor = Color.FromArgb(255, 168, 158);
    else if (line.StartsWith("===") || line.IndexOf("Готово", StringComparison.OrdinalIgnoreCase) >= 0)
      logBox.SelectionColor = Color.FromArgb(126, 214, 180);
    logBox.AppendText(line + "\n");
    logBox.ScrollToCaret();
  }

  async Task StartCheck() {
    string url = (urlBox.Text ?? "").Trim();
    if (string.IsNullOrEmpty(url) || !(url.StartsWith("http://") || url.StartsWith("https://"))) {
      MessageBox.Show(this, "Вставьте полную ссылку (http:// или https://).", "Ссылка", MessageBoxButtons.OK, MessageBoxIcon.Warning);
      return;
    }
    if (running != null && !running.HasExited) return;

    startBtn.Enabled = false;
    stopBtn.Enabled = true;
    SetStatus("Идёт проверка", "run");
    AppendLog("");
    AppendLog("=== Запуск ===");

    try {
      var psi = new ProcessStartInfo();
      psi.FileName = nodePath;
      psi.Arguments = "\"" + Path.Combine(appRoot, "start.js") + "\"";
      psi.WorkingDirectory = appRoot;
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;
      psi.RedirectStandardOutput = true;
      psi.RedirectStandardError = true;
      psi.StandardOutputEncoding = Encoding.UTF8;
      psi.StandardErrorEncoding = Encoding.UTF8;
      psi.EnvironmentVariables["GUI_MODE"] = "1";
      psi.EnvironmentVariables["REPORT_URL"] = url;
      psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";

      running = new Process();
      running.StartInfo = psi;
      running.EnableRaisingEvents = true;
      running.OutputDataReceived += (s, e) => { if (e.Data != null) AppendLog(e.Data); };
      running.ErrorDataReceived += (s, e) => { if (e.Data != null) AppendLog(e.Data); };

      var tcs = new TaskCompletionSource<int>();
      running.Exited += (s, e) => tcs.TrySetResult(running.ExitCode);
      running.Start();
      running.BeginOutputReadLine();
      running.BeginErrorReadLine();

      int code = await tcs.Task;
      AppendLog("=== Завершено (код " + code + ") ===");
      SetStatus(code == 0 ? "Готово" : "Ошибка", code == 0 ? "ok" : "warn");
    } catch (Exception ex) {
      AppendLog("Ошибка: " + ex.Message);
      SetStatus("Ошибка запуска", "warn");
      MessageBox.Show(this, ex.Message, "Ошибка", MessageBoxButtons.OK, MessageBoxIcon.Error);
    } finally {
      running = null;
      startBtn.Enabled = true;
      stopBtn.Enabled = false;
    }
  }

  void StopCheck() {
    try {
      if (running != null && !running.HasExited) {
        running.Kill();
        AppendLog("Остановлено пользователем.");
        SetStatus("Остановлено", "warn");
      }
    } catch (Exception ex) {
      AppendLog("Не удалось остановить: " + ex.Message);
    }
  }

  async Task CheckUpdates(bool interactive) {
    updateBtn.Enabled = false;
    if (interactive) SetStatus("Проверяю обновления", "run");
    try {
      string json = await RunNodeJson("\"" + Path.Combine(appRoot, "scripts", "update-cli.js") + "\" check");
      var status = ParseUpdate(json);
      if (!status.Ok) {
        AppendLog("Не удалось проверить обновления: " + status.Error);
        if (interactive) MessageBox.Show(this, status.Error, "Обновления", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return;
      }

      string shortLocal = string.IsNullOrEmpty(status.Local) ? "—" : status.Local.Substring(0, Math.Min(7, status.Local.Length));
      string shortRemote = string.IsNullOrEmpty(status.Remote) ? "—" : status.Remote.Substring(0, Math.Min(7, status.Remote.Length));

      if (!status.Available) {
        SetStatus("Актуально · " + shortLocal, "ok");
        if (interactive) MessageBox.Show(this, "У вас уже последняя версия с GitHub.", "Обновления", MessageBoxButtons.OK, MessageBoxIcon.Information);
        return;
      }

      SetStatus("Есть обновление · " + shortRemote, "warn");
      if (!interactive) {
        AppendLog("Доступно обновление с GitHub: " + shortRemote + " — " + status.Message);
        return;
      }

      var ask = MessageBox.Show(
        this,
        "Найдено обновление на GitHub.\n\n" + status.Message + "\n\nУстановить сейчас? Профиль браузера и отчёты сохранятся.",
        "Обновления",
        MessageBoxButtons.YesNo,
        MessageBoxIcon.Question
      );
      if (ask != DialogResult.Yes) return;

      AppendLog("Устанавливаю обновление...");
      SetStatus("Устанавливаю", "run");
      string applyJson = await RunNodeJson("\"" + Path.Combine(appRoot, "scripts", "update-cli.js") + "\" apply");
      AppendLog(applyJson);
      SetStatus("Обновлено", "ok");
      MessageBox.Show(this, "Обновление установлено. Можно продолжать работу.", "Обновления", MessageBoxButtons.OK, MessageBoxIcon.Information);
    } catch (Exception ex) {
      AppendLog("Ошибка обновления: " + ex.Message);
      if (interactive) MessageBox.Show(this, ex.Message, "Обновления", MessageBoxButtons.OK, MessageBoxIcon.Error);
    } finally {
      updateBtn.Enabled = true;
    }
  }

  class UpdateStatus {
    public bool Ok;
    public bool Available;
    public string Local;
    public string Remote;
    public string Message;
    public string Error;
  }

  UpdateStatus ParseUpdate(string json) {
    var u = new UpdateStatus();
    u.Ok = true;
    u.Local = ExtractJsonString(json, "localCommit");
    u.Remote = ExtractJsonString(json, "remoteCommit");
    u.Message = ExtractJsonString(json, "message");
    string avail = ExtractJsonRaw(json, "updateAvailable");
    u.Available = avail == "true";
    if (string.IsNullOrEmpty(u.Remote) && json.IndexOf("updateAvailable") < 0) {
      u.Ok = false;
      u.Error = json;
    }
    return u;
  }

  static string ExtractJsonString(string json, string key) {
    string pattern = "\"" + key + "\"";
    int i = json.IndexOf(pattern);
    if (i < 0) return "";
    int colon = json.IndexOf(':', i + pattern.Length);
    if (colon < 0) return "";
    int q1 = json.IndexOf('"', colon + 1);
    if (q1 < 0) return "";
    int q2 = json.IndexOf('"', q1 + 1);
    if (q2 < 0) return "";
    return json.Substring(q1 + 1, q2 - q1 - 1);
  }

  static string ExtractJsonRaw(string json, string key) {
    string pattern = "\"" + key + "\"";
    int i = json.IndexOf(pattern);
    if (i < 0) return "";
    int colon = json.IndexOf(':', i + pattern.Length);
    if (colon < 0) return "";
    int end = colon + 1;
    while (end < json.Length && char.IsWhiteSpace(json[end])) end++;
    int start = end;
    while (end < json.Length && ",}\r\n ".IndexOf(json[end]) < 0) end++;
    return json.Substring(start, end - start).Trim().ToLowerInvariant();
  }

  Task<string> RunNodeJson(string args) {
    return Task.Run(() => {
      var psi = new ProcessStartInfo();
      psi.FileName = nodePath;
      psi.Arguments = args;
      psi.WorkingDirectory = appRoot;
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;
      psi.RedirectStandardOutput = true;
      psi.RedirectStandardError = true;
      psi.StandardOutputEncoding = Encoding.UTF8;
      psi.StandardErrorEncoding = Encoding.UTF8;
      var p = Process.Start(psi);
      string stdout = p.StandardOutput.ReadToEnd();
      string stderr = p.StandardError.ReadToEnd();
      p.WaitForExit();
      if (!string.IsNullOrWhiteSpace(stderr)) {
        foreach (var line in stderr.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
          AppendLog(line);
      }
      if (p.ExitCode != 0 && string.IsNullOrWhiteSpace(stdout)) throw new Exception(stderr);
      return stdout.Trim();
    });
  }
}

public static class Program {
  [STAThread]
  public static void Main() {
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);

    string dir = AppDomain.CurrentDomain.BaseDirectory;
    if (dir.EndsWith("\\") || dir.EndsWith("/")) dir = dir.Substring(0, dir.Length - 1);

    string startJs = Path.Combine(dir, "start.js");
    if (!File.Exists(startJs)) {
      MessageBox.Show("Не найден start.js рядом с программой.\nПоложите «Проверка сделок.exe» в папку приложения.", "Ошибка", MessageBoxButtons.OK, MessageBoxIcon.Error);
      return;
    }

    string node = FindNode(dir);
    if (node == null) {
      MessageBox.Show("Node.js не найден.\nЗапустите установщик ещё раз с галочкой «Скачать Node.js»\nили установите LTS с https://nodejs.org", "Node.js", MessageBoxButtons.OK, MessageBoxIcon.Error);
      return;
    }

    Application.Run(new DealCheckerForm(dir, node));
  }

  static string FindNode(string appRoot) {
    string portable = Path.Combine(appRoot, "runtime", "node", "node.exe");
    if (File.Exists(portable)) return portable;

    try {
      var psi = new ProcessStartInfo();
      psi.FileName = "where.exe";
      psi.Arguments = "node";
      psi.RedirectStandardOutput = true;
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;
      var p = Process.Start(psi);
      string line = p.StandardOutput.ReadLine();
      p.WaitForExit();
      if (!string.IsNullOrWhiteSpace(line) && File.Exists(line.Trim())) return line.Trim();
    } catch { }

    string[] candidates = new string[] {
      Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
      @"C:\Program Files\nodejs\node.exe",
      Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe")
    };
    foreach (string c in candidates) {
      if (!string.IsNullOrEmpty(c) && File.Exists(c)) return c;
    }
    return null;
  }
}
'@

Write-Host "Собираю GUI: $out"
if (Test-Path $out) { Remove-Item -Force $out }

$refs = @(
  'System.dll',
  'System.Core.dll',
  'System.Drawing.dll',
  'System.Windows.Forms.dll'
)

Add-Type -TypeDefinition $code -ReferencedAssemblies $refs -OutputAssembly $out -OutputType WindowsApplication

if (-not (Test-Path $out)) { throw "Не удалось создать GUI exe" }
Write-Host "Готово: $out"
