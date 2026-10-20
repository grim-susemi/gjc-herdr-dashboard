$p = Get-CimInstance Win32_Process -Filter "ProcessId=15292"
if ($p) { "{0} {1}" -f $p.Name, $p.CommandLine } else { "pid 15292 not found" }
