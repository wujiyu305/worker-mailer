import * as crypto from 'node:crypto'

export type User = { name?: string; email: string }

export type EmailOptions = {
  from: string | User
  to: string | string[] | User | User[]
  reply?: string | User
  cc?: string | string[] | User | User[]
  bcc?: string | string[] | User | User[]
  subject: string
  text?: string
  html?: string
  headers?: Record<string, string>
  attachments?: { filename: string; content: string; mimeType?: string }[]
  dsnOverride?: {
    envelopeId?: string
    RET?: {
      HEADERS?: boolean
      FULL?: boolean
    }
    NOTIFY?: {
      DELAY?: boolean
      FAILURE?: boolean
      SUCCESS?: boolean
    }
  }
}

export class Email {
  public readonly from: User
  public readonly to: User[]
  public readonly reply?: User
  public readonly cc?: User[]
  public readonly bcc?: User[]

  public readonly subject: string
  public readonly text?: string
  public readonly html?: string
  public readonly dsnOverride?: {
    envelopeId?: string
    RET?: {
      HEADERS?: boolean
      FULL?: boolean
    }
    NOTIFY?: {
      DELAY?: boolean
      FAILURE?: boolean
      SUCCESS?: boolean
    }
  }

  public readonly attachments?: {
    filename: string
    content: string
    mimeType?: string
  }[]

  public readonly headers: Record<string, string>

  public setSent!: () => void
  public setSentError!: (e: unknown) => void
  public sent = new Promise<void>((resolve, reject) => {
    this.setSent = resolve
    this.setSentError = reject
  })

  constructor(options: EmailOptions) {
    if (!options.text && !options.html) {
      throw new Error('At least one of text or html must be provided')
    }

    if (typeof options.from === 'string') {
      this.from = { email: options.from }
    } else {
      this.from = options.from
    }
    if (typeof options.reply === 'string') {
      this.reply = { email: options.reply }
    } else {
      this.reply = options.reply
    }
    this.to = Email.toUsers(options.to)!
    this.cc = Email.toUsers(options.cc)
    this.bcc = Email.toUsers(options.bcc)

    this.subject = options.subject
    this.text = options.text
    this.html = options.html
    this.attachments = options.attachments
    this.dsnOverride = options.dsnOverride
    this.headers = options.headers || {}
  }

  private static toUsers(
    user: string | string[] | User | User[] | undefined,
  ): User[] | undefined {
    if (!user) {
      return
    }
    if (typeof user === 'string') {
      return [{ email: user }]
    } else if (Array.isArray(user)) {
      return user.map(user => {
        if (typeof user === 'string') {
          return { email: user }
        }
        return user
      })
    } else {
      return [user]
    }
  }

  public getEmailData() {
    this.resolveHeader()

    const headersArray: string[] = ['MIME-Version: 1.0']
    for (const [key, value] of Object.entries(this.headers)) {
      headersArray.push(`${key}: ${value}`)
    }
    const mixedBoundary = this.generateSafeBoundary('mixed_')
    const alternativeBoundary = this.generateSafeBoundary('alternative_')

    headersArray.push(
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    )
    const headers = headersArray.join('\r\n')

    let emailData = `${headers}\r\n\r\n`
    emailData += `--${mixedBoundary}\r\n`

    emailData += `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"\r\n\r\n`

    if (this.text) {
      emailData += `--${alternativeBoundary}\r\n`
      emailData += `Content-Type: text/plain; charset="utf-8"\r\n\r\n`
      const lines = this.wrapText(this.text, 998)   // maximum line length is 998 characters (see RFC 2046)
      emailData += `${lines.join('\r\n')}\r\n\r\n`
    }

    if (this.html) {
      emailData += `--${alternativeBoundary}\r\n`
      emailData += `Content-Type: text/html; charset="utf-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n`
      const lines = this.wrapText(Buffer.from(this.html, 'utf8').toString('base64'), 76)    // maximum line length is 998 characters (see RFC 2046)
      emailData += `${lines.join('\r\n')}\r\n\r\n`
    }

    emailData += `--${alternativeBoundary}--\r\n`

    if (this.attachments) {
      for (const attachment of this.attachments) {
        const mimeType =
          attachment.mimeType || this.getMimeType(attachment.filename)
        emailData += `--${mixedBoundary}\r\n`
        emailData += `Content-Type: ${mimeType}; name="${attachment.filename}"\r\n`
        emailData += `Content-Description: ${attachment.filename}\r\n`
        emailData += `Content-Disposition: attachment; filename="${attachment.filename}";\r\n`
        emailData += `    creation-date="${new Date().toUTCString()}";\r\n`
        emailData += `Content-Transfer-Encoding: base64\r\n\r\n`

        // split the content into multiple lines to avoid line length greater than 76 characters https://en.wikipedia.org/wiki/Base64#Variants_summary_table
        const lines = attachment.content.match(/.{1,72}/g)
        if (lines) {
          emailData += `${lines.join('\r\n')}`
        } else {
          emailData += `${attachment.content}`
        }
        emailData += '\r\n\r\n'
      }
    }
    emailData += `--${mixedBoundary}--\r\n.\r\n`

    return emailData
  }

  private generateSafeBoundary(prefix: string): string {
    let boundary = prefix + crypto.randomBytes(28).toString('hex')

    boundary = boundary.replace(/[<>@,;:\\/[\]?=" ]/g, '_') // Replace unwanted characters with '_'

    return boundary
  }

  private getMimeType(filename: string): string {
    const extension = filename.split('.').pop()?.toLowerCase()

    const mimeTypes: { [key: string]: string } = {
      txt: 'text/plain',
      html: 'text/html',
      csv: 'text/csv',
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      zip: 'application/zip',
    }

    return mimeTypes[extension || 'txt'] || 'application/octet-stream' // Default to 'application/octet-stream'
  }

  private resolveHeader() {
    this.resolveFrom()
    this.resolveTo()
    this.resolveReply()
    this.resolveCC()
    this.resolveBCC()
    this.resolveSubject()
    this.headers['Date'] = new Date().toUTCString()
    this.headers['Message-ID'] = this.headers['Message-ID'] || 
      `<${crypto.randomUUID()}@${this.from.email.split('@').pop()}>`
  }

  private resolveFrom() {
    let from = this.from.email
    if (this.from.name) {
      from = `${this.from.name} <${from}>`
    }
    this.headers['From'] = from
  }

  private resolveTo() {
    const toAddresses = this.to.map(user => {
      if (user.name) {
        return `${user.name} <${user.email}>`
      }
      return user.email
    })
    this.headers['To'] = toAddresses.join(', ')
  }

  private resolveSubject() {
    this.headers['Subject'] = `=?utf-8?b?${Buffer.from(this.subject, 'utf8').toString('base64')}?=`
  }

  private resolveReply() {
    if (this.reply) {
      let replyAddress = this.reply.email
      if (this.reply.name) {
        replyAddress = `${this.reply.name} <${replyAddress}>`
      }
      this.headers['Reply-To'] = replyAddress
    }
  }

  private resolveCC() {
    if (this.cc) {
      const ccAddresses = this.cc.map(user => {
        if (user.name) {
          return `${user.name} <${user.email}>`
        }
        return user.email
      })
      this.headers['CC'] = ccAddresses.join(', ')
    }
  }

  private resolveBCC() {
    if (this.bcc) {
      const bccAddresses = this.bcc.map(user => {
        if (user.name) {
          return `${user.name} <${user.email}>`
        }
        return user.email
      })
      // this.headers['BCC'] = bccAddresses.join(', ')
    }
  }

  private wrapText(text: string, maxLength = 998) {
    const lines = []
    let currentLine = ''

    const words = text.match(/\S+/g) || [] // Matches non-whitespace chunks

    for (const word of words) {
      // if the word is longer than the max length, it is forcefully split into chunks
      if (word.length > maxLength) {
        if (currentLine) {
          lines.push(currentLine)
          currentLine = ''
        }

        for (let i = 0; i < word.length; i += maxLength) {
          lines.push(word.slice(i, i + maxLength))
        }
      } else if (
        // current line + word + space + 1 (for the space) <= max length
        currentLine.length + word.length + (currentLine ? 1 : 0) <=
        maxLength
      ) {
        currentLine += (currentLine ? ' ' : '') + word
      } else {
        lines.push(currentLine)
        currentLine = word
      }
    }

    if (currentLine) {
      lines.push(currentLine)
    }

    return lines
  }
}
