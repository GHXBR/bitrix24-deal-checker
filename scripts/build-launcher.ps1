# Собирает «Проверка сделок.exe» — двойной клик запускает проверку без ручного терминала.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path $root 'Проверка сделок.exe'

$code = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

public static class Program {
  public static int Main() {
    try {
      Console.OutputEncoding = Encoding.UTF8;
    } catch {
    }

    string dir = AppDomain.CurrentDomain.BaseDirectory;
    if (dir.EndsWith("\\") || dir.EndsWith("/")) {
      dir = dir.Substring(0, dir.Length - 1);
    }

    string startJs = Path.Combine(dir, "start.js");
    if (!File.Exists(startJs)) {
      Console.WriteLine("Не найден start.js рядом с программой.");
      Console.WriteLine("Положите файл «Проверка сделок.exe» в папку проекта.");
      Pause();
      return 1;
    }

    string node = FindNode();
    if (node == null) {
      Console.WriteLine("Node.js не найден.");
      Console.WriteLine("Установите LTS с https://nodejs.org и запустите снова.");
      Pause();
      return 1;
    }

    Console.Title = "Проверка сделок Битрикс24";
    Console.WriteLine("Запуск проверки сделок...");
    Console.WriteLine();

    ProcessStartInfo psi = new ProcessStartInfo();
    psi.FileName = node;
    psi.Arguments = "\"" + startJs + "\"";
    psi.WorkingDirectory = dir;
    psi.UseShellExecute = false;

    try {
      Process p = Process.Start(psi);
      if (p == null) {
        Console.WriteLine("Не удалось запустить Node.js.");
        Pause();
        return 1;
      }
      p.WaitForExit();
      Console.WriteLine();
      Pause();
      return p.ExitCode;
    } catch (Exception ex) {
      Console.WriteLine("Ошибка запуска: " + ex.Message);
      Pause();
      return 1;
    }
  }

  static void Pause() {
    Console.WriteLine("Нажмите Enter, чтобы закрыть окно...");
    try { Console.ReadLine(); } catch { }
  }

  static string FindNode() {
    try {
      ProcessStartInfo psi = new ProcessStartInfo();
      psi.FileName = "where.exe";
      psi.Arguments = "node";
      psi.RedirectStandardOutput = true;
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;
      Process p = Process.Start(psi);
      string line = p.StandardOutput.ReadLine();
      p.WaitForExit();
      if (!string.IsNullOrWhiteSpace(line)) {
        string path = line.Trim();
        if (File.Exists(path)) return path;
      }
    } catch {
    }

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

Write-Host "Собираю: $out"
if (Test-Path $out) { Remove-Item -Force $out }

Add-Type -TypeDefinition $code -Language CSharp -OutputAssembly $out -OutputType ConsoleApplication

if (-not (Test-Path $out)) {
  throw "Не удалось создать exe"
}

Write-Host "Готово: $out"
Write-Host "Запуск: двойной клик по «Проверка сделок.exe»"
