/**
 * Реализация CryptoProvider поверх КриптоПро ЭЦП Browser plug-in.
 *
 * Загрузчик и типы COM-объектов — в `./cades`. Официальный
 * `cadesplugin_api.js` на странице не подключается: см. пояснение в
 * `cades/loader.ts`.
 */

import { base64ToBytes, bytesToBase64 } from './base64.js'
import { commonName, innFrom } from './rdn.js'
import {
  CadesLoadError,
  CadesType,
  ContentEncoding,
  OutputEncoding,
  ProductType,
  StoreLocation,
  StoreName,
  StoreOpenMode,
  loadCadesPlugin,
  toCryptoError,
  type CadesCertificate,
  type CadesPlugin,
  type CadesStore,
} from './cades/index.js'
import {
  CryptoError,
  pemToBase64,
  type CertInfo,
  type CertStore,
  type CryptoProvider,
  type ProviderStatus,
  type Recipient,
  type VerifyResult,
} from './types.js'

const STORE_NAMES: Readonly<Record<CertStore, StoreName>> = {
  my: StoreName.My,
  addressbook: StoreName.AddressBook,
}

function shortDate(value: string): string {
  return String(value).slice(0, 10)
}

export class CryptoProProvider implements CryptoProvider {
  readonly id = 'cryptopro'
  readonly title = 'КриптоПро ЭЦП Browser plug-in'
  /** CSP показывает собственное окно ввода ПИН, своего поля не нужно. */
  readonly requiresPin = false

  private plugin: CadesPlugin | null = null
  /** Объекты сертификатов из хранилищ, по внутреннему идентификатору. */
  private readonly certificates = new Map<string, CadesCertificate>()

  private require(): CadesPlugin {
    if (!this.plugin) throw new CryptoError('Плагин не загружен. Сначала выполните проверку.')
    return this.plugin
  }

  async detect(): Promise<ProviderStatus> {
    try {
      const { plugin, extension } = await loadCadesPlugin()
      this.plugin = plugin

      const about = await plugin.createObject('CAdESCOM.About')
      const version = await about.Version

      let cspVersion: string | undefined
      try {
        // CSPVersion отдаёт объект, а не строку — см. CadesVersion в contract.ts
        cspVersion = await (await about.CSPVersion('', ProductType.Csp)).toString()
      } catch {
        // необязательно: часть сборок это не поддерживает
      }

      return {
        available: true,
        version,
        cspVersion,
        extension: `${extension.title} · ${extension.id}`,
      }
    } catch (error) {
      if (error instanceof CadesLoadError) {
        return { available: false, reason: error.message, hint: error.hint }
      }
      const wrapped = toCryptoError(error, 'Не удалось загрузить плагин')
      return { available: false, reason: wrapped.message, hint: wrapped.hint }
    }
  }

  async listCertificates(store: CertStore): Promise<CertInfo[]> {
    const plugin = this.require()
    const storeName = STORE_NAMES[store]

    let comStore: CadesStore
    try {
      comStore = await plugin.createObject('CAdESCOM.Store')
      await comStore.Open(StoreLocation.CurrentUser, storeName, StoreOpenMode.MaximumAllowed)
    } catch (error) {
      throw toCryptoError(
        error,
        `Не удалось открыть хранилище «${storeName}»`,
        'Проверьте, что КриптоПро CSP запущен и доступен.',
      )
    }

    try {
      const collection = await comStore.Certificates
      const count = await collection.Count
      const result: CertInfo[] = []

      // нумерация с единицы — соглашение CAPICOM
      for (let index = 1; index <= count; index++) {
        const certificate = await collection.Item(index)
        const [subject, issuer, validFrom, validTo, thumbprint] = await Promise.all([
          certificate.SubjectName,
          certificate.IssuerName,
          certificate.ValidFromDate,
          certificate.ValidToDate,
          certificate.Thumbprint,
        ])

        const id = `${store}:${thumbprint}`
        this.certificates.set(id, certificate)
        result.push({
          id,
          subject,
          issuer,
          issuerCn: commonName(issuer),
          cn: commonName(subject),
          validFrom: shortDate(validFrom),
          validTo: shortDate(validTo),
          thumbprint,
          inn: innFrom(subject),
        })
      }
      return result
    } catch (error) {
      throw toCryptoError(error, 'Не удалось перечислить сертификаты')
    } finally {
      try {
        await comStore.Close()
      } catch {
        // хранилище могло не открыться — закрывать нечего
      }
    }
  }

  private certificate(certId: string): CadesCertificate {
    const certificate = this.certificates.get(certId)
    if (!certificate) throw new CryptoError('Сертификат не найден. Обновите список сертификатов.')
    return certificate
  }

  async exportCertificate(certId: string): Promise<Uint8Array> {
    try {
      // Base64 — единственная рабочая кодировка: на Binary плагин 2.0.15700
      // отвечает 0x80070057 «Параметр задан неверно»
      return base64ToBytes(await this.certificate(certId).Export(OutputEncoding.Base64))
    } catch (error) {
      throw toCryptoError(error, 'Не удалось выгрузить сертификат')
    }
  }

  async verifyDetached(signature: string, data: Uint8Array): Promise<VerifyResult> {
    const plugin = this.require()
    try {
      const signedData = await plugin.createObject('CAdESCOM.CadesSignedData')
      await signedData.propset_ContentEncoding(ContentEncoding.Base64ToBinary)
      await signedData.propset_Content(bytesToBase64(data))
      // порядок и аргументы — как на демо-странице КриптоПро: подписанные
      // данные задаются заранее, третий аргумент отмечает открепленную подпись
      await signedData.VerifyCades(signature, CadesType.Bes, true)
      return { valid: true }
    } catch (error) {
      // расхождение подписи вендор сообщает исключением, а не значением
      return { valid: false, reason: toCryptoError(error, 'Подпись не подтверждена').message }
    }
  }

  async signDetached(certId: string, data: Uint8Array): Promise<string> {
    const plugin = this.require()
    const certificate = this.certificate(certId)

    try {
      const signer = await plugin.createObject('CAdESCOM.CPSigner')
      await signer.propset_Certificate(certificate)

      const signedData = await plugin.createObject('CAdESCOM.CadesSignedData')
      await signedData.propset_ContentEncoding(ContentEncoding.Base64ToBinary)
      await signedData.propset_Content(bytesToBase64(data))

      const signature = await signedData.SignCades(signer, CadesType.Bes, true)
      return signature.replace(/[\r\n]/g, '')
    } catch (error) {
      throw toCryptoError(
        error,
        'Не удалось подписать',
        'Проверьте, что сертификат связан с закрытым ключом и токен вставлен.',
      )
    }
  }

  async encrypt(recipients: readonly Recipient[], data: Uint8Array): Promise<string> {
    const plugin = this.require()
    if (!recipients.length) throw new CryptoError('Не указан ни один получатель шифрования')

    try {
      const enveloped = await plugin.createObject('CAdESCOM.CPEnvelopedData')
      await enveloped.propset_ContentEncoding(ContentEncoding.Base64ToBinary)
      await enveloped.propset_Content(bytesToBase64(data))

      // Алгоритм шифрования здесь не выбирается намеренно. У объекта есть
      // propset_Algorithm, но в плагине 2.0.15700 он отвечает 0x80004001
      // «Не поддерживается» на все три ГОСТ-значения (28147-89, Магма,
      // Кузнечик). Алгоритм определяет CSP по ключу получателя; повлиять на
      // выбор можно настройкой CSP, но не отсюда.

      const list = await enveloped.Recipients
      for (const recipient of recipients) {
        let certificate: CadesCertificate
        if (recipient.kind === 'store') {
          certificate = this.certificate(recipient.certId)
        } else {
          // сертификат получателя пришёл строкой — импортируем во временный
          // объект, в хранилище пользователя ничего не кладём
          certificate = await plugin.createObject('CAdESCOM.Certificate')
          await certificate.Import(pemToBase64(recipient.pem))
        }
        await list.Add(certificate)
      }

      const encrypted = await enveloped.Encrypt(OutputEncoding.Base64)
      return encrypted.replace(/[\r\n]/g, '')
    } catch (error) {
      throw toCryptoError(
        error,
        'Не удалось зашифровать',
        'Проверьте сертификат получателя: он должен быть предназначен для шифрования.',
      )
    }
  }
}
