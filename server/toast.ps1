# Shows one Windows toast. Called by server/notify.js with a base64 JSON payload { title, body, url, silent }.
# The payload never touches the script text, so notification content cannot inject commands.
param([Parameter(Mandatory = $true)][string]$Payload)
$ErrorActionPreference = 'Stop'

$d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>')
$texts = $xml.GetElementsByTagName('text')
$texts.Item(0).InnerText = [string]$d.title   # InnerText escapes the content
$texts.Item(1).InnerText = [string]$d.body

$root = $xml.DocumentElement
if ($d.url) {
  $root.SetAttribute('activationType', 'protocol')
  $root.SetAttribute('launch', [string]$d.url)
}
if ($d.silent) {
  $audio = $xml.CreateElement('audio')
  $audio.SetAttribute('silent', 'true')
  $root.AppendChild($audio) | Out-Null
}

# Windows PowerShell's own app id: a toast needs a registered source, and this avoids touching the registry.
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
