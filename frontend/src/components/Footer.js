import React, { Fragment, useState } from 'react';
import { Box, Link, Typography } from '@mui/material';
import LegalDialog from './LegalDialog';
import ContactDialog from './ContactDialog';

/** href 가 없으면 링크 없이 글자만 표시, dialog 면 화면 안 대화상자로 표시 */
const LINKS = [
  { label: '이용약관', dialog: 'terms' },
  { label: '개인정보처리방침', dialog: 'privacy' },
  { label: '문의하기', dialog: 'contact' },
  { label: '카카오톡 채널', href: 'http://pf.kakao.com/_eFiFX' },
  { label: 'PlanGo 네이버카페', href: 'https://cafe.naver.com/plango5' },
];

const textSx = { fontSize: '0.75rem', color: 'text.secondary', whiteSpace: 'nowrap' };
const linkSx = { ...textSx, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } };

const FooterLink = ({ item, onOpenDialog }) => {
  if (item.dialog) {
    return (
      <Link component="button" type="button" onClick={() => onOpenDialog(item.dialog)} sx={linkSx}>
        {item.label}
      </Link>
    );
  }
  return item.href ? (
    <Link href={item.href} target="_blank" rel="noopener noreferrer" sx={linkSx}>
      {item.label}
    </Link>
  ) : (
    <Typography component="span" sx={textSx}>
      {item.label}
    </Typography>
  );
};

const Divider = () => <Box component="span" sx={{ width: '1px', height: 10, bgcolor: 'divider' }} />;

const Footer = ({ appVersion }) => {
  const [openDialog, setOpenDialog] = useState(null);
  return (
    <Box
      component="footer"
      sx={{
        mt: 6,
        pt: 2,
        borderTop: 1,
        borderColor: 'divider',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        flexWrap: 'wrap',
        columnGap: 1.5,
        rowGap: 0.5,
      }}
    >
      {LINKS.map((item, i) => (
        <Fragment key={item.label}>
          {i > 0 && <Divider />}
          <FooterLink item={item} onOpenDialog={setOpenDialog} />
        </Fragment>
      ))}
      <Divider />
      <Typography
        component="span"
        sx={(theme) => ({
          ...textSx,
          fontWeight: 600,
          color: theme.palette.mode === 'dark' ? '#e3b341' : '#b8860b',
        })}
      >
        © {new Date().getFullYear()} PlanGo.Today
      </Typography>
      <LegalDialog
        doc={openDialog === 'terms' || openDialog === 'privacy' ? openDialog : null}
        onClose={() => setOpenDialog(null)}
      />
      <ContactDialog
        open={openDialog === 'contact'}
        onClose={() => setOpenDialog(null)}
        appVersion={appVersion}
      />
    </Box>
  );
};

export default Footer;
