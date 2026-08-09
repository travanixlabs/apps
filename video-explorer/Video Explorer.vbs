' Video Explorer — silent launcher.
' Starts the local server with no console window and opens the app window.
' Double-click this file, or make a desktop shortcut to it.

Dim shell, fso, appDir, running, exec

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = appDir

' If the server is already up, just open a second window instead of a
' second server — the port would be taken and node would exit.
running = False
On Error Resume Next
Set exec = shell.Exec("cmd /c netstat -ano -p tcp | findstr LISTENING | findstr :4321")
If Err.Number = 0 Then
  If InStr(exec.StdOut.ReadAll(), ":4321") > 0 Then running = True
End If
On Error GoTo 0

If running Then
  ' Server already running: ask it to open another window.
  shell.Run "cmd /c start """" http://127.0.0.1:4321", 0, False
Else
  ' 0 = hidden window, False = don't block. The server opens the app window.
  shell.Run "cmd /c node server.js", 0, False
End If
