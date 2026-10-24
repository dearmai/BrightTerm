# Windows 코드 서명용 셀프 인증서 — 만들기 · 공개 인증서 내보내기 · 개인 키 백업
#
#   powershell -ExecutionPolicy Bypass -File scripts\codesign-cert.ps1            # 없으면 만들고 build\codesign\ 에 .cer 내보내기
#   powershell -ExecutionPolicy Bypass -File scripts\codesign-cert.ps1 -BackupPfx D:\safe\brightterm-codesign.pfx
#
# 개인 키는 이 PC 의 현재 사용자 인증서 저장소(Cert:\CurrentUser\My)에만 있다. 서명(npm run dist:win:signed)은 거기서 꺼내 쓴다.
# 다른 PC 에서 빌드하거나 PC 를 바꿀 때를 위해 -BackupPfx 로 비밀번호 걸린 .pfx 를 안전한 곳에 백업해 둔다 — 저장소에 넣지 말 것.
# 배포 대상 PC 에는 공개 인증서(.cer)만 등록한다: build\codesign\install-cert.cmd
param(
  [string]$Subject = 'CN=Dany Kim, O=BrightTerm',
  [int]$Years = 5,
  [string]$BackupPfx
)
$ErrorActionPreference = 'Stop'
$outDir = Join-Path $PSScriptRoot '..\build\codesign'
$cerPath = Join-Path $outDir 'BrightTerm-codesign.cer'

$certs = @(Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) })
if ($certs.Count -gt 1) { throw "'$Subject' 코드 서명 인증서가 $($certs.Count)개 있습니다. certmgr.msc 에서 하나만 남기세요: $($certs.Thumbprint -join ', ')" }
if ($certs.Count -eq 1) {
  $cert = $certs[0]
  Write-Host "기존 인증서 사용: $($cert.Thumbprint) (만료 $($cert.NotAfter.ToString('yyyy-MM-dd')))"
} else {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject `
    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears($Years) -CertStoreLocation Cert:\CurrentUser\My
  Write-Host "새 인증서 만듦: $($cert.Thumbprint) (만료 $($cert.NotAfter.ToString('yyyy-MM-dd')))"
}

New-Item -ItemType Directory -Force $outDir | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT | Out-Null
Write-Host "공개 인증서: $((Resolve-Path $cerPath).Path)"

if ($BackupPfx) {
  $pw = Read-Host '백업 .pfx 비밀번호' -AsSecureString
  Export-PfxCertificate -Cert $cert -FilePath $BackupPfx -Password $pw | Out-Null
  Write-Host "개인 키 백업: $BackupPfx (다른 PC 에서는 Import-PfxCertificate -FilePath <pfx> -CertStoreLocation Cert:\CurrentUser\My)"
}
