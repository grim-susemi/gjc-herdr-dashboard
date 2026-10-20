Get-CimInstance Win32_Process -Filter "Name='gjc.exe'" | ForEach-Object {
  $c = $_.CommandLine
  if ($c.Length -gt 140) { $c = $c.Substring(0, 140) }
  "{0} ppid={1} created={2} cmd={3}" -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate, $c
}
$l = Get-Item "C:\Users\USER\.gjc\agent\sdk\sessions\index.jsonl.lock" -Force
"lock created={0} children={1}" -f $l.CreationTime, @(Get-ChildItem $l.FullName -Force).Count
