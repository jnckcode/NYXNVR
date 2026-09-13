Dim WshShell, FSO, scriptDir, daemonScript
Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

scriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
daemonScript = scriptDir & "\daemon-runner.js"

' Run node daemon-runner.js completely hidden without console popup (0 = hidden)
WshShell.Run "node """ & daemonScript & """", 0, False
