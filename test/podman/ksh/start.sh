#!/bin/sh
# 두 sshd 를 띄운다. 22 번은 기본 설정(SFTP 사용), 2222 번은 SFTP 서브시스템 없음.
set -e
/usr/sbin/sshd -e -f /etc/ssh/sshd_nosftp_config
exec /usr/sbin/sshd -D -e
