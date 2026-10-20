Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,ParentProcessId,@{n='cmd';e={$_.CommandLine.Substring(0,[Math]::Min(150,$_.CommandLine.Length))}} | Format-List
