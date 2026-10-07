# Copies lines from .env to your clipboard so you can paste them into Railway. Prints only a count, never the values.
#
#   Whole lines (for Railway's Raw Editor):
#     powershell -NoProfile -File scripts/copy-env.ps1 RESEND_API_KEY EMAIL_FROM
#   Just the value of ONE variable (for the Value box of Railway's "New Variable"):
#     powershell -NoProfile -File scripts/copy-env.ps1 -ValueOnly HOVER_CLIENT_SECRET
param(
  [switch]$ValueOnly,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Names
)

$found = @()
foreach ($line in Get-Content (Join-Path $PSScriptRoot '..\.env')) {
  $parts = $line -split '=', 2
  if ($parts.Count -eq 2 -and ($Names -contains $parts[0].Trim())) { $found += , $parts }
}
if ($found.Count -eq 0) { Write-Host 'No matching lines found in .env'; exit 1 }

if ($ValueOnly) {
  if ($Names.Count -ne 1) { Write-Host 'Give exactly one name with -ValueOnly'; exit 1 }
  $v = $found[0][1].Trim().Trim('"').Trim("'")
  Set-Clipboard -Value $v
  Write-Host ("Copied the value of " + $Names[0] + " (" + $v.Length + " characters)")
} else {
  (($found | ForEach-Object { $_[0].Trim() + '=' + $_[1].Trim() }) -join [Environment]::NewLine) | Set-Clipboard
  Write-Host ("Copied " + $found.Count + " of " + $Names.Count + " lines to the clipboard")
}
