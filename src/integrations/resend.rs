use resend_rs::types::CreateEmailBaseOptions;
use resend_rs::{Resend, Result};
use std::env;

const PRIMARY_COL: &str = "#5b35d5";
const SECONDARY_BG: &str = "#F8F8FC";
const SECONDARY_TEXT: &str = "#84809f";
const BG_COL: &str = "#dedcee";
const PROJECT_NAME: &str = "Scaffold";
const SUPPORT_URL: &str = "https://example.com/support";


pub fn sign_up_verification_code_template(code: &str) -> String {
    format!(r#"
<!DOCTYPE html PUBLIC '-//W3C//DTD XHTML 1.0 Strict//EN' 'http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd'>
<html
  data-editor-version='2'
  class='sg-campaigns'
  xmlns='http://www.w3.org/1999/xhtml'
>
  <head>
    <meta http-equiv='Content-Type' content='text/html; charset=utf-8' />
    <meta
      name='viewport'
      content='width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1'
    />
    <!--[if !mso]>
      <!-->
    <meta http-equiv='X-UA-Compatible' content='IE=Edge' />
    <!--<![endif]-->
    <!--[if (gte mso 9)|(IE)]>
      <xml>
        <o:OfficeDocumentSettings>
          <o:AllowPNG />
          <o:PixelsPerInch>96</o:PixelsPerInch>
        </o:OfficeDocumentSettings>
      </xml>
    <![endif]-->
    <!--[if (gte mso 9)|(IE)]>
      <style type='text/css'>
        body {{
          width: 600px;
          margin: 0 auto;
}}
        table {{
          border-collapse: collapse;
}}
        table,
        td {{
          mso-table-lspace: 0pt;
          mso-table-rspace: 0pt;
}}
        img {{
          -ms-interpolation-mode: bicubic;
}}
      </style>
    <![endif]-->
    <style type='text/css'>
      body,
      p,
      div {{
        font-family: arial, helvetica, sans-serif;
        font-size: 16px;
}}

      body {{
        color: white;
}}

      body a {{
        color: {PRIMARY_COL};
        text-decoration: none;
}}

      p {{
        margin: 0;
        padding: 0;
}}

      table.wrapper {{
        width: 100% !important;
        table-layout: fixed;
        -webkit-font-smoothing: antialiased;
        -webkit-text-size-adjust: 100%;
        -moz-text-size-adjust: 100%;
        -ms-text-size-adjust: 100%;
}}

      img.max-width {{
        max-width: 100% !important;
}}

      .column.of-2 {{
        width: 50%;
}}

      .column.of-3 {{
        width: 33.333%;
}}

      .column.of-4 {{
        width: 25%;
}}

      @media screen and (max-width: 480px) {{
        .preheader .rightColumnContent,
        .footer .rightColumnContent {{
          text-align: left !important;
}}

        .preheader .rightColumnContent div,
        .preheader .rightColumnContent span,
        .footer .rightColumnContent div,
        .footer .rightColumnContent span {{
          text-align: left !important;
}}

        .preheader .rightColumnContent,
        .preheader .leftColumnContent {{
          font-size: 80% !important;
          padding: 5px 0;
}}

        table.wrapper-mobile {{
          width: 100% !important;
          table-layout: fixed;
}}

        img.max-width {{
          height: auto !important;
          max-width: 100% !important;
}}

        a.bulletproof-button {{
          display: block !important;
          width: auto !important;
          font-size: 80%;
          padding-left: 0 !important;
          padding-right: 0 !important;
}}

        .columns {{
          width: 100% !important;
}}

        .column {{
          display: block !important;
          width: 100% !important;
          padding-left: 0 !important;
          padding-right: 0 !important;
          margin-left: 0 !important;
          margin-right: 0 !important;
}}

        .social-icon-column {{
          display: inline-block !important;
}}
}}
    </style>
    <!--user entered Head Start-->
    <!--End Head user entered-->
  </head>

  <body>
    <center
      class='wrapper'
      data-link-color='{PRIMARY_COL}'
      data-body-style='font-size:16px; font-family:arial,helvetica,sans-serif; color:white; background-color:{SECONDARY_BG};'
    >
      <div class='webkit'>
        <table
          cellpadding='0'
          cellspacing='0'
          border='0'
          width='100%'
          class='wrapper'
          background-color='{SECONDARY_BG}'
        >
          <tr>
            <td valign='top' background-color='{SECONDARY_BG}' width='100%'>
              <table
                width='100%'
                role='content-container'
                class='outer'
                align='center'
                cellpadding='0'
                cellspacing='0'
                border='0'
              >
                <tr>
                  <td width='100%'>
                    <table
                      width='100%'
                      cellpadding='0'
                      cellspacing='0'
                      border='0'
                    >
                      <tr>
                        <td>
                          <!--[if mso]>
                            <center>
                              <table>
                                <tr>
                                  <td width='600'>
                                  <![endif]-->
                          <table
                            width='100%'
                            cellpadding='0'
                            cellspacing='0'
                            border='0'
                            style='width: 100%; max-width: 600px'
                            align='center'
                          >
                            <tr>
                              <td
                                role='modules-container'
                                style='
                                  padding: 0px 0px 0px 0px;
                                  color: white;
                                  text-align: left;
                                '
                                background-color='white'
                                width='100%'
                                align='left'
                              >
                                <table
                                  class='module preheader preheader-hide'
                                  role='module'
                                  data-type='preheader'
                                  border='0'
                                  cellpadding='0'
                                  cellspacing='0'
                                  width='100%'
                                  style='
                                    display: none !important;
                                    mso-hide: all;
                                    visibility: hidden;
                                    opacity: 0;
                                    color: transparent;
                                    height: 0;
                                    width: 0;
                                  '
                                >
                                  <tr>
                                    <td role='module-content'>
                                      <p>
                                        Secure your {PROJECT_NAME} account by verifying
                                        your email address.
                                      </p>
                                    </td>
                                  </tr>
                                </table>
                                <table
                                  border='0'
                                  cellpadding='0'
                                  cellspacing='0'
                                  align='center'
                                  width='100%'
                                  role='module'
                                  data-type='columns'
                                  style='padding: 0px 0px 0px 0px'
                                  background-color='{PRIMARY_COL}'
                                  data-distribution='1,1'
                                >
                                  <tbody>
                                    <tr role='module-content'>
                                      <td height='100%' valign='top'>
                                        <table
                                          width='290'
                                          style='
                                            width: 290px;
                                            border-spacing: 0;
                                            border-collapse: collapse;
                                            margin: 0px 10px 0px 0px;
                                          '
                                          cellpadding='0'
                                          cellspacing='0'
                                          align='left'
                                          border='0'
                                          background-color=''
                                          class='column column-0'
                                        >
                                          <tbody>
                                            <tr>
                                              <td
                                                style='
                                                  padding: 0px;
                                                  margin: 0px;
                                                  border-spacing: 0;
                                                '
                                              >
                                                <table
                                                  class='wrapper'
                                                  role='module'
                                                  data-type='image'
                                                  border='0'
                                                  cellpadding='0'
                                                  cellspacing='0'
                                                  width='100%'
                                                  style='table-layout: fixed'
                                                  data-muid='214e5601-35a6-4fe7-911a-62959a775603'
                                                >
                                                  <tbody>
                                                    <tr>
                                                      <td
                                                        style='
                                                          font-size: 6px;
                                                          line-height: 10px;
                                                          padding: 64px 0px 64px
                                                            40px;
                                                        '
                                                        valign='top'
                                                        align='left'
                                                      >
                                                        <img
                                                          class='max-width'
                                                          border='0'
                                                          style='
                                                            display: block;
                                                            color: #000000;
                                                            text-decoration: none;
                                                            font-family:
                                                              Helvetica, arial,
                                                              sans-serif;
                                                            font-size: 16px;
                                                            max-width: 50% !important;
                                                            width: 50%;
                                                            height: auto !important;
                                                          '
                                                          width='145'
                                                          alt=''
                                                          data-proportionally-constrained='true'
                                                          data-responsive='true'
                                                          src='http://cdn.mcauto-images-production.sendgrid.net/a90d076f0ce0a6f1/86dafa7f-db3d-4718-badb-97b455cd2392/450x120.png'
                                                        />
                                                      </td>
                                                    </tr>
                                                  </tbody>
                                                </table>
                                              </td>
                                            </tr>
                                          </tbody>
                                        </table>
                                        <table
                                          width='290'
                                          style='
                                            width: 290px;
                                            border-spacing: 0;
                                            border-collapse: collapse;
                                            margin: 0px 0px 0px 10px;
                                          '
                                          cellpadding='0'
                                          cellspacing='0'
                                          align='left'
                                          border='0'
                                          background-color=''
                                          class='column column-1'
                                        >
                                          <tbody>
                                            <tr>
                                              <td
                                                style='
                                                  padding: 0px;
                                                  margin: 0px;
                                                  border-spacing: 0;
                                                '
                                              ></td>
                                            </tr>
                                          </tbody>
                                        </table>
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                                <table
                                  border='0'
                                  cellpadding='0'
                                  cellspacing='0'
                                  align='center'
                                  width='100%'
                                  role='module'
                                  data-type='columns'
                                  style='padding: 0px 0px 40px 0px'
                                  background-color='{PRIMARY_COL}'
                                  data-distribution='1'
                                >
                                  <tbody>
                                    <tr role='module-content'>
                                      <td height='100%' valign='top'>
                                        <table
                                          width='580'
                                          style='
                                            width: 580px;
                                            border-spacing: 0;
                                            border-collapse: collapse;
                                            margin: 0px 10px 0px 10px;
                                          '
                                          cellpadding='0'
                                          cellspacing='0'
                                          align='left'
                                          border='0'
                                          background-color=''
                                          class='column column-0'
                                        >
                                          <tbody>
                                            <tr>
                                              <td
                                                style='
                                                  padding: 0px;
                                                  margin: 0px;
                                                  border-spacing: 0;
                                                '
                                              >
                                                <table
                                                  class='module'
                                                  role='module'
                                                  data-type='text'
                                                  border='0'
                                                  cellpadding='0'
                                                  cellspacing='0'
                                                  width='100%'
                                                  style='table-layout: fixed'
                                                  data-muid='d6628df0-8f24-439e-9923-264e845eac3c'
                                                  data-mc-module-version='2019-10-22'
                                                >
                                                  <tbody>
                                                    <tr>
                                                      <td
                                                        style='
                                                          padding: 16px 80px 0px
                                                            32px;
                                                          line-height: 40px;
                                                          text-align: inherit;
                                                        '
                                                        height='100%'
                                                        valign='top'
                                                        background-color=''
                                                        role='module-content'
                                                      >
                                                        <div>
                                                          <div
                                                            style='
                                                              font-family: inherit;
                                                              text-align: inherit;
                                                            '
                                                          >
                                                            <span
                                                              style='
                                                                font-size: 48px;
                                                                color: white;
                                                              '
                                                              >Verify your
                                                              email</span
                                                            >
                                                          </div>
                                                          <div></div>
                                                        </div>
                                                      </td>
                                                    </tr>
                                                  </tbody>
                                                </table>
                                              </td>
                                            </tr>
                                          </tbody>
                                        </table>
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                                <table
                                  class='module'
                                  role='module'
                                  data-type='text'
                                  border='0'
                                  cellpadding='0'
                                  cellspacing='0'
                                  width='100%'
                                  style='table-layout: fixed'
                                  data-muid='65921ceb-990e-4437-838c-c7b8ba7a420d'
                                  data-mc-module-version='2019-10-22'
                                >
                                  <tbody>
                                    <tr>
                                      <td
                                        style='
                                          padding: 24px 32px 32px 32px;
                                          line-height: 22px;
                                          text-align: inherit;
                                          background-color: white;
                                        '
                                        height='100%'
                                        valign='top'
                                        background-color='white'
                                        role='module-content'
                                      >
                                        <div>
                                          <div
                                            style='
                                              font-family: inherit;
                                              text-align: inherit;
                                            '
                                          >
                                            <br />
                                          </div>
                                          <div
                                            style='
                                              font-family: inherit;
                                              text-align: inherit;
                                            '
                                          >
                                            <span
                                              style='
                                                font-style: normal;
                                                font-variant-ligatures: normal;
                                                font-variant-caps: normal;
                                                font-weight: 400;
                                                letter-spacing: normal;
                                                orphans: 2;
                                                text-align: justify;
                                                text-indent: 0px;
                                                text-transform: none;
                                                white-space: normal;
                                                widows: 2;
                                                word-spacing: 0px;
                                                -webkit-text-stroke-width: 0px;
                                                background-color: rgb(
                                                  255,
                                                  255,
                                                  255
                                                );
                                                text-decoration-style: initial;
                                                text-decoration-color: initial;
                                                float: none;
                                                display: inline;
                                                color: #322b5f;
                                                font-family:
                                                  arial, helvetica, sans-serif;
                                                font-size: 18px;
                                              '
                                              >To complete and secure your
                                              {PROJECT_NAME} account, we need to verify
                                              your email address.</span
                                            >
                                          </div>
                                          <div></div>
                                        </div>
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                                <table
                                  border='0'
                                  cellpadding='0'
                                  cellspacing='0'
                                  class='module'
                                  data-role='module-button'
                                  data-type='button'
                                  role='module'
                                  style='table-layout: fixed'
                                  width='100%'
                                  data-muid='d99c9a07-0c86-4635-be8a-d4ed4b9271a3'
                                >
                                  <tbody>
                                    <tr>
                                      <td
                                        align='left'
                                        background-color='{PRIMARY_COL}'
                                        class='outer-td'
                                        style='padding: 0px 0px 40px 32px'
                                      >
                                        <table
                                          border='0'
                                          cellpadding='0'
                                          cellspacing='0'
                                          class='wrapper-mobile'
                                          style='text-align: center'
                                        >
                                          <tbody>
                                            <tr>
                                              <td
                                                align='center'
                                                background-color='{PRIMARY_COL}'
                                                class='inner-td'
                                                style='
                                                  border-radius: 6px;
                                                  font-size: 16px;
                                                  text-align: left;
                                                  background-color: inherit;
                                                '
                                              >
                                                <div
                                                  style='
                                                    background-color: {PRIMARY_COL};
                                                    border: 0px solid #333333;
                                                    border-color: #333333;
                                                    border-radius: 4px;
                                                    border-width: 0px;
                                                    color: white;
                                                    display: inline-block;
                                                    font-size: 18px;
                                                    font-weight: 700;
                                                    letter-spacing: 0px;
                                                    line-height: 40px;
                                                    padding: 8px 16px 8px 16px;
                                                    text-align: center;
                                                    text-decoration: none;
                                                    border-style: solid;
                                                    font-family:
                                                      arial, helvetica,
                                                      sans-serif;
                                                  '
                                                  target='_blank'
                                                  >{code}</div
                                                >
                                              </td>
                                            </tr>
                                          </tbody>
                                        </table>
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                                <table
                                  class='module'
                                  role='module'
                                  data-type='divider'
                                  border='0'
                                  cellpadding='0'
                                  cellspacing='0'
                                  width='100%'
                                  style='table-layout: fixed'
                                  data-muid='0c64d472-087e-451d-a879-1fe43c7a5fb2'
                                >
                                  <tbody>
                                    <tr>
                                      <td
                                        style='padding: 0px 32px 0px 32px'
                                        role='module-content'
                                        height='100%'
                                        valign='top'
                                        background-color=''
                                      >
                                        <table
                                          border='0'
                                          cellpadding='0'
                                          cellspacing='0'
                                          align='center'
                                          width='100%'
                                          height='1px'
                                          style='
                                            line-height: 1px;
                                            font-size: 1px;
                                          '
                                        >
                                          <tbody>
                                            <tr>
                                              <td
                                                style='padding: 0px 0px 1px 0px'
                                                background-color='{BG_COL}'
                                              ></td>
                                            </tr>
                                          </tbody>
                                        </table>
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                                <table
                                  class='module'
                                  role='module'
                                  data-type='text'
                                  border='0'
                                  cellpadding='0'
                                  cellspacing='0'
                                  width='100%'
                                  style='table-layout: fixed'
                                  data-muid='b851a91d-7518-40df-a4eb-cb5a8d797584'
                                  data-mc-module-version='2019-10-22'
                                >
                                  <tbody>
                                    <tr>
                                      <td
                                        style='
                                          padding: 32px 32px 18px 32px;
                                          line-height: 22px;
                                          text-align: inherit;
                                          background-color: white;
                                        '
                                        height='100%'
                                        valign='top'
                                        background-color='white'
                                        role='module-content'
                                      >
                                        <div>
                                          <div
                                            style='
                                              font-family: inherit;
                                              text-align: inherit;
                                            '
                                          >
                                            <span
                                              style='
                                                color: {SECONDARY_TEXT};
                                                font-size: 14px;
                                              '
                                              >Have a question? Visit our
                                            </span>
                                            <a
                                              href='https://sendgrid.com/invalidlink'
                                              ><span
                                                style='
                                                  font-size: 14px;
                                                  color: {PRIMARY_COL};
                                                '
                                                ><u>Help Center</u></span
                                              > </a
                                            ><span
                                              style='
                                                color: {SECONDARY_TEXT};
                                                font-size: 14px;
                                              '
                                              >.</span
                                            >
                                          </div>
                                          <div
                                            style='
                                              font-family: inherit;
                                              text-align: inherit;
                                            '
                                          >
                                            <span
                                              style='
                                                color: {SECONDARY_TEXT};
                                                font-size: 14px;
                                              '
                                              >802E Whiting St, Tampa, FL 33602
                                              &nbsp;| &nbsp;(954) 859-1302
                                              &nbsp;|
                                              &nbsp;{SUPPORT_URL}</span
                                            >
                                          </div>
                                          <div
                                            style='
                                              font-family: inherit;
                                              text-align: inherit;
                                            '
                                          >
                                            <span
                                              style='
                                                color: {SECONDARY_TEXT};
                                                font-size: 14px;
                                              '
                                              >© {PROJECT_NAME}, Inc. All rights
                                              reserved.</span
                                            >
                                          </div>
                                          <div></div>
                                        </div>
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                                <table
                                  class='module'
                                  role='module'
                                  data-type='social'
                                  align='center'
                                  border='0'
                                  cellpadding='0'
                                  cellspacing='0'
                                  width='100%'
                                  style='table-layout: fixed'
                                  data-muid='b45c9e63-dc4b-419f-88cc-7a0a6aa7c592'
                                >
                                  <tbody>
                                    <tr>
                                      <td
                                        valign='top'
                                        style='
                                          padding: 0px 0px 32px 30px;
                                          font-size: 6px;
                                          line-height: 10px;
                                          background-color: white;
                                        '
                                        align='left'
                                      >
                                        <table
                                          align='left'
                                          style='
                                            -webkit-margin-start: auto;
                                            -webkit-margin-end: auto;
                                          '
                                        >
                                          <tbody>
                                            <tr align='left'>
                                              <td
                                                style='padding: 0px 5px'
                                                class='social-icon-column'
                                              >
                                                <a
                                                  role='social-icon-link'
                                                  href='https://twitter.com/withpanther'
                                                  target='_blank'
                                                  alt='Twitter'
                                                  title='Twitter'
                                                  style='
                                                    display: inline-block;
                                                    background-color: {BG_COL};
                                                    height: 32px;
                                                    width: 32px;
                                                    border-radius: 4px;
                                                    -webkit-border-radius: 4px;
                                                    -moz-border-radius: 4px;
                                                  '
                                                >
                                                  <img
                                                    role='social-icon'
                                                    alt='Twitter'
                                                    title='Twitter'
                                                    src='https://mc.sendgrid.com/assets/social/white/twitter.png'
                                                    style='
                                                      height: 32px;
                                                      width: 32px;
                                                    '
                                                    height='32'
                                                    width='32'
                                                  />
                                                </a>
                                              </td>
                                              <td
                                                style='padding: 0px 5px'
                                                class='social-icon-column'
                                              >
                                                <a
                                                  role='social-icon-link'
                                                  href='https://www.instagram.com/accounts/login/'
                                                  target='_blank'
                                                  alt='Instagram'
                                                  title='Instagram'
                                                  style='
                                                    display: inline-block;
                                                    background-color: {BG_COL};
                                                    height: 32px;
                                                    width: 32px;
                                                    border-radius: 4px;
                                                    -webkit-border-radius: 4px;
                                                    -moz-border-radius: 4px;
                                                  '
                                                >
                                                  <img
                                                    role='social-icon'
                                                    alt='Instagram'
                                                    title='Instagram'
                                                    src='https://mc.sendgrid.com/assets/social/white/instagram.png'
                                                    style='
                                                      height: 32px;
                                                      width: 32px;
                                                    '
                                                    height='32'
                                                    width='32'
                                                  />
                                                </a>
                                              </td>
                                              <td
                                                style='padding: 0px 5px'
                                                class='social-icon-column'
                                              >
                                                <a
                                                  role='social-icon-link'
                                                  href='https://www.linkedin.com/company/withpanther/'
                                                  target='_blank'
                                                  alt='LinkedIn'
                                                  title='LinkedIn'
                                                  style='
                                                    display: inline-block;
                                                    background-color: {BG_COL};
                                                    height: 32px;
                                                    width: 32px;
                                                    border-radius: 4px;
                                                    -webkit-border-radius: 4px;
                                                    -moz-border-radius: 4px;
                                                  '
                                                >
                                                  <img
                                                    role='social-icon'
                                                    alt='LinkedIn'
                                                    title='LinkedIn'
                                                    src='https://mc.sendgrid.com/assets/social/white/linkedin.png'
                                                    style='
                                                      height: 32px;
                                                      width: 32px;
                                                    '
                                                    height='32'
                                                    width='32'
                                                  />
                                                </a>
                                              </td>
                                            </tr>
                                          </tbody>
                                        </table>
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          </table>
                          <!--[if mso]>
                                  </td>
                                </tr>
                              </table>
                            </center>
                          <![endif]-->
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </div>
    </center>
  </body>
</html>
    "#)
}

pub async fn send_email(email: &str, sub: &str, body: &str) -> Result<(), resend_rs::Error> {
    let resend_api = env::var("RESEND_API_KEY")
    .expect("RESEND_API_KEY must be set on .env file");

    let resend = Resend::new(&resend_api);

    let from = "Fanari <no-reply@sabbirhassan.com>";
    let to = [email];

    let email = CreateEmailBaseOptions::new(from, to, sub)
      .with_html(body);

    let result = resend.emails.send(email).await;

    if let Err(err) = result {
        log::error!("{:?}", err);
        return Err(err);
    }

    Ok(())
}