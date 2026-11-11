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
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

public static class Theme {
  // Фирменный красный чуть темнее и спокойнее.
  public static readonly Color Brand = Color.FromArgb(158, 28, 28);
  public static readonly Color BrandHot = Color.FromArgb(138, 22, 22);
  public static readonly Color BrandDeep = Color.FromArgb(112, 16, 16);
  public static readonly Color BrandSoft = Color.FromArgb(248, 232, 232);
  public static readonly Color Canvas = Color.FromArgb(247, 248, 250);
  public static readonly Color Surface = Color.White;
  public static readonly Color Ink = Color.FromArgb(24, 24, 24);
  public static readonly Color Muted = Color.FromArgb(120, 120, 128);
  public static readonly Color Line = Color.FromArgb(226, 228, 232);
  public static readonly Color Track = Color.FromArgb(236, 238, 242);
  public static readonly Color Ghost = Color.White;
  public static readonly Color GhostHot = Color.FromArgb(248, 249, 251);
  public static readonly Color OkBg = Color.FromArgb(232, 245, 236);
  public static readonly Color OkFg = Color.FromArgb(28, 110, 60);
  public static readonly Color RunBg = Color.FromArgb(248, 232, 232);
  public static readonly Color RunFg = Color.FromArgb(138, 22, 22);
  public static readonly Color WarnBg = Color.FromArgb(255, 243, 220);
  public static readonly Color WarnFg = Color.FromArgb(146, 90, 12);
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

  // Transparent у родителя в WinForms даёт чёрные углы — ищем непрозрачный цвет.
  public static Color OpaqueBack(Control c) {
    Control cur = c;
    while (cur != null) {
      Color b = cur.BackColor;
      if (b.A == 255 && b.ToArgb() != Color.Transparent.ToArgb()) return b;
      cur = cur.Parent;
    }
    return Theme.Canvas;
  }

  public static void FillBack(Graphics g, Control c) {
    using (var br = new SolidBrush(OpaqueBack(c))) {
      g.FillRectangle(br, c.ClientRectangle);
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
    Height = 40;
    Font = new Font("Segoe UI Semibold", 10f);
    // Без Region: иначе чёрные/рваные углы на Transparent-родителе.
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
    BackColor = Color.Transparent;
    ApplyColors();
  }

  void ApplyColors() {
    if (IsPrimary) {
      _base = Theme.Brand; _hover = Theme.BrandHot; _press = Theme.BrandDeep;
      ForeColor = Color.White;
    } else {
      _base = Theme.Ghost; _hover = Theme.GhostHot; _press = Color.FromArgb(240, 241, 244);
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
    e.Graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
    e.Graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
    Draw.FillBack(e.Graphics, this);
    Color fill = !Enabled ? Color.FromArgb(230, 232, 236) : (_down ? _press : (_over ? _hover : _base));
    Color text = !Enabled ? Color.FromArgb(150, 154, 162) : ForeColor;
    int radius = Math.Max(12, Height / 2);
    using (var path = Draw.Round(new Rectangle(0, 0, Width - 1, Height - 1), radius))
    using (var br = new SolidBrush(fill)) {
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
  }
  protected override void OnPaintBackground(PaintEventArgs e) {
    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
    Draw.FillBack(e.Graphics, this);
    using (var path = Draw.Round(new Rectangle(0, 0, Width - 1, Height - 1), 18))
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
    Height = 34;
    Font = new Font("Segoe UI Semibold", 9f);
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
    BackColor = Color.Transparent;
  }
  public void SetState(string text, string kind) {
    Text = text;
    if (kind == "run") { _bg = Theme.RunBg; _fg = Theme.RunFg; }
    else if (kind == "warn") { _bg = Theme.WarnBg; _fg = Theme.WarnFg; }
    else { _bg = Theme.OkBg; _fg = Theme.OkFg; }
    Width = Math.Max(140, TextRenderer.MeasureText(Text, Font).Width + 32);
    Invalidate();
  }
  protected override void OnPaint(PaintEventArgs e) {
    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
    e.Graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
    // Важно: не Clear(Transparent) — из этого получаются чёрные углы.
    Draw.FillBack(e.Graphics, this);
    using (var path = Draw.Round(new Rectangle(0, 0, Width - 1, Height - 1), Height / 2))
    using (var br = new SolidBrush(_bg))
    using (var pen = new Pen(Color.FromArgb(48, _fg))) {
      e.Graphics.FillPath(br, path);
      e.Graphics.DrawPath(pen, path);
    }
    TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, _fg,
      TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
  }
}

public class ProgressTrack : Control {
  double _value;
  public ProgressTrack() {
    Height = 14;
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    BackColor = Theme.Surface;
  }
  public double Value {
    get { return _value; }
    set {
      _value = Math.Max(0, Math.Min(1, value));
      Invalidate();
    }
  }
  protected override void OnPaint(PaintEventArgs e) {
    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
    Draw.FillBack(e.Graphics, this);
    var rect = new Rectangle(0, 0, Width - 1, Height - 1);
    using (var path = Draw.Round(rect, Height / 2))
    using (var track = new SolidBrush(Theme.Track)) {
      e.Graphics.FillPath(track, path);
    }
    int fillW = (int)Math.Round((Width - 1) * _value);
    if (fillW > 4) {
      var fillRect = new Rectangle(0, 0, fillW, Height - 1);
      using (var path = Draw.Round(fillRect, Height / 2))
      using (var br = new SolidBrush(Theme.Brand)) {
        e.Graphics.FillPath(br, path);
      }
    }
  }
}

public class DealCheckerForm : Form {
  TextBox urlBox;
  Label dealLabel;
  Label progressLabel;
  ProgressTrack progressBar;
  UiButton startBtn;
  UiButton stopBtn;
  UiButton updateBtn;
  StatusPill statusPill;
  Process running;
  string appRoot;
  string nodePath;
  Panel headerHost;
  int totalDeals;
  int currentDeal;

  static readonly Regex DealLine = new Regex(
    @"\[(\d+)\s*/\s*(\d+)\]\s*#(\d+)\s+(.+?)\s+[—\-]",
    RegexOptions.Compiled
  );
  static readonly Regex FoundDeals = new Regex(
    @"Найдено сделок:\s*(\d+)",
    RegexOptions.Compiled | RegexOptions.IgnoreCase
  );

  public DealCheckerForm(string root, string node) {
    appRoot = root;
    nodePath = node;
    Text = "Проверка сделок";
    Width = 860;
    Height = 520;
    MinimumSize = new Size(720, 460);
    StartPosition = FormStartPosition.CenterScreen;
    Font = new Font("Segoe UI", 10f);
    BackColor = Theme.Canvas;
    DoubleBuffered = true;

    Paint += (s, e) => {
      using (var br = new SolidBrush(Theme.Canvas))
        e.Graphics.FillRectangle(br, ClientRectangle);
      using (var accent = new SolidBrush(Theme.Brand))
        e.Graphics.FillRectangle(accent, 0, 0, 6, Height);
    };

    headerHost = new Panel();
    headerHost.Left = 34;
    headerHost.Top = 28;
    headerHost.Width = ClientSize.Width - 68;
    headerHost.Height = 52;
    headerHost.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
    // Не Transparent: иначе дочерние кнопки рисуют чёрные углы.
    headerHost.BackColor = Theme.Canvas;
    Controls.Add(headerHost);

    var brand = new Label();
    brand.Text = "Проверка сделок";
    brand.Font = new Font("Segoe UI Semibold", 24f, FontStyle.Bold);
    brand.ForeColor = Theme.Ink;
    brand.AutoSize = true;
    brand.Location = new Point(0, 6);
    brand.BackColor = Color.Transparent;
    headerHost.Controls.Add(brand);

    updateBtn = new UiButton("Обновления", false);
    updateBtn.Width = 124;
    updateBtn.Height = 34;
    updateBtn.Top = 8;
    updateBtn.Click += async (s, e) => await CheckUpdates(true);
    headerHost.Controls.Add(updateBtn);

    statusPill = new StatusPill();
    statusPill.SetState("Готово к работе", "ok");
    statusPill.Top = 9;
    statusPill.Anchor = AnchorStyles.Top | AnchorStyles.Right;
    headerHost.Controls.Add(statusPill);
    headerHost.Resize += (s, e) => LayoutHeader();

    var card = new SoftCard();
    card.Left = 34;
    card.Top = 96;
    card.Width = ClientSize.Width - 68;
    card.Height = 150;
    card.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
    Controls.Add(card);

    var urlLabel = new Label();
    urlLabel.Text = "ССЫЛКА НА ОТЧЁТ CRM";
    urlLabel.Font = new Font("Segoe UI Semibold", 8.5f);
    urlLabel.ForeColor = Theme.Muted;
    urlLabel.AutoSize = true;
    urlLabel.Location = new Point(26, 20);
    urlLabel.BackColor = Theme.Surface;
    card.Controls.Add(urlLabel);

    var urlShell = new Panel();
    urlShell.Location = new Point(26, 44);
    urlShell.Size = new Size(card.Width - 52, 40);
    urlShell.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
    urlShell.BackColor = Theme.Surface;
    urlShell.Padding = new Padding(12, 8, 12, 8);
    urlShell.Paint += (s, e) => {
      e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
      Draw.FillBack(e.Graphics, urlShell);
      using (var path = Draw.Round(new Rectangle(0, 0, urlShell.Width - 1, urlShell.Height - 1), 12))
      using (var br = new SolidBrush(Color.FromArgb(250, 250, 252)))
      using (var pen = new Pen(Theme.Line)) {
        e.Graphics.FillPath(br, path);
        e.Graphics.DrawPath(pen, path);
      }
    };
    card.Controls.Add(urlShell);

    urlBox = new TextBox();
    urlBox.BorderStyle = BorderStyle.None;
    urlBox.Font = new Font("Segoe UI", 11f);
    urlBox.Dock = DockStyle.Fill;
    urlBox.BackColor = Color.FromArgb(250, 250, 252);
    urlBox.ForeColor = Theme.Ink;
    urlShell.Controls.Add(urlBox);

    startBtn = new UiButton("Запустить", true);
    startBtn.Width = 150;
    startBtn.Location = new Point(26, 98);
    startBtn.Click += async (s, e) => await StartCheck();
    card.Controls.Add(startBtn);

    stopBtn = new UiButton("Остановить", false);
    stopBtn.Width = 130;
    stopBtn.Location = new Point(188, 98);
    stopBtn.Enabled = false;
    stopBtn.Click += (s, e) => StopCheck();
    card.Controls.Add(stopBtn);

    var progressCard = new SoftCard();
    progressCard.Left = 34;
    progressCard.Top = 266;
    progressCard.Width = ClientSize.Width - 68;
    progressCard.Height = 170;
    progressCard.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
    Controls.Add(progressCard);

    var progressTitle = new Label();
    progressTitle.Text = "ХОД ПРОВЕРКИ";
    progressTitle.Font = new Font("Segoe UI Semibold", 8.5f);
    progressTitle.ForeColor = Theme.Muted;
    progressTitle.AutoSize = true;
    progressTitle.Location = new Point(26, 22);
    progressTitle.BackColor = Theme.Surface;
    progressCard.Controls.Add(progressTitle);

    dealLabel = new Label();
    dealLabel.Text = "Ожидание запуска";
    dealLabel.Font = new Font("Segoe UI Semibold", 16f);
    dealLabel.ForeColor = Theme.Ink;
    dealLabel.AutoSize = false;
    dealLabel.Location = new Point(26, 54);
    dealLabel.Size = new Size(progressCard.Width - 52, 36);
    dealLabel.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
    dealLabel.BackColor = Theme.Surface;
    progressCard.Controls.Add(dealLabel);

    progressLabel = new Label();
    progressLabel.Text = "0 / 0";
    progressLabel.Font = new Font("Segoe UI", 10f);
    progressLabel.ForeColor = Theme.Muted;
    progressLabel.AutoSize = true;
    progressLabel.Location = new Point(26, 98);
    progressLabel.BackColor = Theme.Surface;
    progressCard.Controls.Add(progressLabel);

    progressBar = new ProgressTrack();
    progressBar.Location = new Point(26, 128);
    progressBar.Size = new Size(progressCard.Width - 52, 14);
    progressBar.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
    progressBar.Value = 0;
    progressCard.Controls.Add(progressBar);

    FormClosing += (s, e) => {
      if (running != null && !running.HasExited) {
        try { running.Kill(); } catch { }
      }
    };

    Shown += (s, e) => LayoutHeader();
  }

  void LayoutHeader() {
    statusPill.Left = Math.Max(0, headerHost.Width - statusPill.Width);
    updateBtn.Left = Math.Max(0, statusPill.Left - updateBtn.Width - 12);
  }

  void SetStatus(string text, string kind) {
    if (InvokeRequired) { BeginInvoke(new Action(() => SetStatus(text, kind))); return; }
    statusPill.SetState(text, kind);
    LayoutHeader();
  }

  void ResetProgress() {
    totalDeals = 0;
    currentDeal = 0;
    dealLabel.Text = "Подготовка...";
    progressLabel.Text = "0 / 0";
    progressBar.Value = 0;
  }

  void HandleOutputLine(string line) {
    if (InvokeRequired) { BeginInvoke(new Action(() => HandleOutputLine(line))); return; }
    if (string.IsNullOrWhiteSpace(line)) return;

    var found = FoundDeals.Match(line);
    if (found.Success) {
      totalDeals = int.Parse(found.Groups[1].Value);
      currentDeal = 0;
      dealLabel.Text = "Найдено сделок: " + totalDeals;
      progressLabel.Text = "0 / " + totalDeals;
      progressBar.Value = 0;
      return;
    }

    var deal = DealLine.Match(line);
    if (deal.Success) {
      currentDeal = int.Parse(deal.Groups[1].Value);
      totalDeals = int.Parse(deal.Groups[2].Value);
      string id = deal.Groups[3].Value;
      string title = deal.Groups[4].Value.Trim();
      dealLabel.Text = "#" + id + "  " + title;
      progressLabel.Text = currentDeal + " / " + totalDeals;
      progressBar.Value = totalDeals > 0 ? (double)currentDeal / totalDeals : 0;
      return;
    }

    if (line.IndexOf("Открываю браузер", StringComparison.OrdinalIgnoreCase) >= 0) {
      dealLabel.Text = "Открываю браузер...";
      return;
    }
    if (line.IndexOf("Excel", StringComparison.OrdinalIgnoreCase) >= 0 ||
        line.IndexOf("Готово", StringComparison.OrdinalIgnoreCase) >= 0) {
      dealLabel.Text = "Формирую Excel-отчёт...";
      if (totalDeals > 0) progressBar.Value = 1;
    }
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
    ResetProgress();

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
      running.OutputDataReceived += (s, e) => { if (e.Data != null) HandleOutputLine(e.Data); };
      running.ErrorDataReceived += (s, e) => { if (e.Data != null) HandleOutputLine(e.Data); };

      var tcs = new TaskCompletionSource<int>();
      running.Exited += (s, e) => tcs.TrySetResult(running.ExitCode);
      running.Start();
      running.BeginOutputReadLine();
      running.BeginErrorReadLine();

      int code = await tcs.Task;
      if (code == 0) {
        dealLabel.Text = "Готово — отчёт в Excel";
        if (totalDeals > 0) {
          progressLabel.Text = totalDeals + " / " + totalDeals;
          progressBar.Value = 1;
        }
        SetStatus("Готово", "ok");
      } else {
        dealLabel.Text = "Проверка завершилась с ошибкой";
        SetStatus("Ошибка", "warn");
      }
    } catch (Exception ex) {
      dealLabel.Text = "Ошибка запуска";
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
        dealLabel.Text = "Остановлено";
        SetStatus("Остановлено", "warn");
      }
    } catch (Exception ex) {
      MessageBox.Show(this, "Не удалось остановить: " + ex.Message, "Ошибка", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
  }

  async Task CheckUpdates(bool interactive) {
    updateBtn.Enabled = false;
    if (interactive) SetStatus("Проверяю обновления", "run");
    try {
      string json = await RunNodeJson("\"" + Path.Combine(appRoot, "scripts", "update-cli.js") + "\" check");
      var status = ParseUpdate(json);
      if (!status.Ok) {
        if (interactive) MessageBox.Show(this, status.Error, "Обновления", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return;
      }

      string shortLocal = string.IsNullOrEmpty(status.Local) ? "—" : status.Local.Substring(0, Math.Min(7, status.Local.Length));
      string shortRemote = string.IsNullOrEmpty(status.Remote) ? "—" : status.Remote.Substring(0, Math.Min(7, status.Remote.Length));

      if (!status.Available) {
        SetStatus("Актуально · " + shortLocal, "ok");
        if (interactive) {
          MessageBox.Show(this, "У вас уже последняя версия с GitHub.", "Обновления", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        return;
      }

      SetStatus("Есть обновление · " + shortRemote, "warn");
      if (!interactive) return;

      var ask = MessageBox.Show(
        this,
        "Найдено обновление на GitHub.\n\n" + status.Message + "\n\nУстановить сейчас? Профиль браузера и отчёты сохранятся.",
        "Обновления",
        MessageBoxButtons.YesNo,
        MessageBoxIcon.Question
      );
      if (ask != DialogResult.Yes) return;

      SetStatus("Устанавливаю", "run");
      dealLabel.Text = "Устанавливаю обновление...";
      string applyJson = await RunNodeJson(
        "\"" + Path.Combine(appRoot, "scripts", "update-cli.js") + "\" apply",
        true
      );
      bool updated = ExtractJsonRaw(applyJson, "updated") == "true";
      if (updated) {
        SetStatus("Перезапуск", "run");
        BeginInvoke(new Action(() => Application.Exit()));
        return;
      }
      SetStatus("Актуально", "ok");
      MessageBox.Show(this, "Обновление установлено. Можно продолжать работу.", "Обновления", MessageBoxButtons.OK, MessageBoxIcon.Information);
    } catch (Exception ex) {
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

  Task<string> RunNodeJson(string args, bool forUpdateApply = false) {
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
      if (forUpdateApply) {
        psi.EnvironmentVariables["UPDATE_HOST_PID"] = Process.GetCurrentProcess().Id.ToString();
      }
      var p = Process.Start(psi);
      string stdout = p.StandardOutput.ReadToEnd();
      string stderr = p.StandardError.ReadToEnd();
      p.WaitForExit();
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
