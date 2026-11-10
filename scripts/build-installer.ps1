# Собирает «Установить.exe» — один файл для коллег.
# Внутри: распаковывает Install-App.ps1 и запускает его.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ps1 = Join-Path $root 'installer\Install-App.ps1'
$out = Join-Path $root 'Установить.exe'

if (-not (Test-Path $ps1)) { throw "Не найден $ps1" }

$bytes = [System.IO.File]::ReadAllBytes($ps1)
$b64 = [Convert]::ToBase64String($bytes)

$code = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

public static class Program {
  [STAThread]
  public static void Main() {
    Application.EnableVisualStyles();
    try {
      string tmpDir = Path.Combine(Path.GetTempPath(), "b24-deal-installer-" + Guid.NewGuid().ToString("n"));
      Directory.CreateDirectory(tmpDir);
      string script = Path.Combine(tmpDir, "Install-App.ps1");
      byte[] data = Convert.FromBase64String("$b64");
      File.WriteAllBytes(script, data);

      ProcessStartInfo psi = new ProcessStartInfo();
      psi.FileName = "powershell.exe";
      psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"";
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;

      Process p = Process.Start(psi);
      if (p == null) {
        MessageBox.Show("Не удалось запустить PowerShell.", "Установщик", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return;
      }
      p.WaitForExit();

      try { Directory.Delete(tmpDir, true); } catch { }
    } catch (Exception ex) {
      MessageBox.Show(ex.Message, "Установщик", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
  }
}
"@

Write-Host "Собираю установщик: $out"
if (Test-Path $out) { Remove-Item -Force $out }

$refs = @('System.dll', 'System.Windows.Forms.dll')
Add-Type -TypeDefinition $code -ReferencedAssemblies $refs -OutputAssembly $out -OutputType WindowsApplication

if (-not (Test-Path $out)) { throw 'Не удалось создать Установить.exe' }
Write-Host "Готово: $out"
Write-Host 'Отправьте коллегам этот файл — остальное скачается с GitHub.'
